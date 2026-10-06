#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define MAX_ENV_BYTES (64 * 1024)
#ifndef MAX_SCAN_BYTES
#define MAX_SCAN_BYTES (8 * 1024 * 1024)
#endif
#ifndef MAX_PROCESSES
#define MAX_PROCESSES 32768
#endif
#ifndef MAX_TARGETS
#define MAX_TARGETS 512
#endif
#define MARKER_PREFIX "ORCA_PTY_TREE_ID="

struct cleanup {
    char marker[sizeof(MARKER_PREFIX) + 36];
    size_t marker_length;
    int targets[MAX_TARGETS];
    size_t target_count;
    size_t signaled_count;
    double deadline;
    bool unverifiable;
};

static volatile sig_atomic_t stopping = 0;

static void request_stop(int sig) {
    (void)sig;
    stopping = 1;
}

static double monotonic_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1.0;
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static bool within_deadline(double deadline) {
    double now = monotonic_seconds();
    return !stopping && now >= 0 && now < deadline;
}

static bool valid_marker(const char *marker) {
    if (strlen(marker) != 36) return false;
    for (size_t i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (marker[i] != '-') return false;
        } else if (!((marker[i] >= '0' && marker[i] <= '9') ||
                     (marker[i] >= 'a' && marker[i] <= 'f'))) return false;
    }
    return true;
}

static bool matches_marker(const char *bytes, size_t length, const struct cleanup *state) {
    size_t offset = 0;
    while (offset < length) {
        const char *end = memchr(bytes + offset, '\0', length - offset);
        if (!end) return false;
        size_t field_length = (size_t)(end - (bytes + offset));
        if (field_length == state->marker_length &&
            memcmp(bytes + offset, state->marker, field_length) == 0) return true;
        offset += field_length + 1;
    }
    return false;
}

static bool vanished(int error) {
    return error == ENOENT || error == ESRCH;
}

/* Linux 5.1 accepts a /proc PID-directory descriptor, without pidfd_open (5.3). */
static int signal_handle(int fd, int sig) {
    return (int)syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0);
}

static bool send_owned(struct cleanup *state, int fd, int sig) {
    if (signal_handle(fd, sig) == 0) return true;
    if (errno != ESRCH) state->unverifiable = true;
    return false;
}

static size_t inspect_process(struct cleanup *state, int proc, const char *name,
                              int sig, double deadline) {
    /* Both the ownership read and every signal use this one immutable process reference. */
    int target = openat(proc, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (target < 0) {
        if (!vanished(errno)) state->unverifiable = true;
        return 0;
    }
    int environ = openat(target, "environ", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (environ < 0) {
        if (!vanished(errno)) state->unverifiable = true;
        close(target);
        return 0;
    }
    char bytes[MAX_ENV_BYTES + 1];
    size_t length = 0;
    bool readable = true;
    while (length < sizeof(bytes)) {
        if (!within_deadline(deadline)) {
            readable = false;
            state->unverifiable = true;
            break;
        }
        ssize_t count = read(environ, bytes + length, sizeof(bytes) - length);
        if (count < 0) {
            if (errno == EINTR) continue;
            if (!vanished(errno)) state->unverifiable = true;
            readable = false;
            break;
        }
        if (count == 0) break;
        length += (size_t)count;
    }
    close(environ);
    if (length > MAX_ENV_BYTES) {
        readable = false;
        state->unverifiable = true;
    }
    if (readable && matches_marker(bytes, length, state)) {
        if (state->signaled_count >= MAX_TARGETS ||
            (sig == SIGTERM && state->target_count >= MAX_TARGETS)) state->unverifiable = true;
        else if (!within_deadline(deadline)) state->unverifiable = true;
        else if (send_owned(state, target, sig)) {
            ++state->signaled_count;
            if (sig == SIGTERM) {
                state->targets[state->target_count++] = target;
                target = -1;
            }
        }
    }
    if (target >= 0) close(target);
    return length;
}

static bool process_name(const char *name) {
    if (!*name) return false;
    for (const char *c = name; *c; ++c) if (*c < '0' || *c > '9') return false;
    return true;
}

static void scan(struct cleanup *state, int sig, double deadline) {
    state->signaled_count = 0;
    DIR *proc = opendir("/proc");
    if (!proc) {
        state->unverifiable = true;
        return;
    }
    size_t count = 0, bytes = 0;
    char own_pid[32];
    snprintf(own_pid, sizeof(own_pid), "%ld", (long)getpid());
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(proc);
        if (!entry) {
            if (errno) state->unverifiable = true;
            break;
        }
        if (!process_name(entry->d_name)) continue;
        if (++count > MAX_PROCESSES || bytes >= MAX_SCAN_BYTES ||
            state->signaled_count >= MAX_TARGETS || !within_deadline(deadline)) {
            state->unverifiable = true;
            break;
        }
        if (strcmp(entry->d_name, "1") == 0 || strcmp(entry->d_name, own_pid) == 0) continue;
        bytes += inspect_process(state, dirfd(proc), entry->d_name, sig, deadline);
    }
    closedir(proc);
}

static void wait_grace(double until) {
    while (within_deadline(until)) {
        double remaining = until - monotonic_seconds();
        if (remaining <= 0) return;
        struct timespec delay = { .tv_sec = (time_t)remaining,
            .tv_nsec = (long)((remaining - (double)(time_t)remaining) * 1000000000.0) };
        if (nanosleep(&delay, NULL) != 0 && errno != EINTR) return;
    }
}

static void kill_captured(struct cleanup *state) {
    for (size_t i = 0; i < state->target_count; ++i) {
        send_owned(state, state->targets[i], SIGKILL);
        close(state->targets[i]);
    }
    state->target_count = 0;
}

static int run_cleanup(const char *marker, double budget) {
    struct cleanup state = {0};
    snprintf(state.marker, sizeof(state.marker), MARKER_PREFIX "%s", marker);
    state.marker_length = strlen(state.marker);
    double started = monotonic_seconds();
    if (started < 0) return 2;
    state.deadline = started + budget;
    scan(&state, SIGTERM, started + budget / 4.0);
    double grace = budget / 2.0 < 2.0 ? budget / 2.0 : 2.0;
    double until = monotonic_seconds() + grace;
    if (until > state.deadline - 0.1) until = state.deadline - 0.1;
    if (state.target_count) wait_grace(until);
    /* Escalate retained handles before a second scan can spend the remaining budget. */
    kill_captured(&state);
    scan(&state, SIGKILL, state.deadline);
    return state.unverifiable || stopping ? 2 : 0;
}

#ifndef ORCA_GUEST_TREE_KILL_TESTING
int main(int argc, char **argv) {
    if (argc != 3 || !valid_marker(argv[1])) {
        fprintf(stderr, "unverifiable: invalid cleanup arguments\n");
        return 2;
    }
    char *end = NULL;
    errno = 0;
    long budget_ms = strtol(argv[2], &end, 10);
    if (errno || !*argv[2] || *end || budget_ms <= 0 || budget_ms > 3000) {
        fprintf(stderr, "unverifiable: invalid cleanup budget\n");
        return 2;
    }
    int self = open("/proc/self", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (self < 0 || signal_handle(self, 0) != 0) {
        if (self >= 0) close(self);
        fprintf(stderr, "unverifiable: kernel process-handle signaling unavailable\n");
        return 3;
    }
    close(self);
    struct sigaction action = {0};
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
    int result = run_cleanup(argv[1], (double)budget_ms / 1000.0);
    if (result) fprintf(stderr, "unverifiable: guest process scan or signal incomplete\n");
    return result;
}
#endif
