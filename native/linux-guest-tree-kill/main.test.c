#define _GNU_SOURCE
#include <assert.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>

static const char *fixture_root;
static int signals_seen;
static int scans_seen;
static int last_signal;
static int signal_error;
static ino_t expected_inode;
static DIR *fixture_opendir(const char *name) {
    (void)name;
    ++scans_seen;
    return opendir(fixture_root);
}
static long fixture_syscall(long number, ...);
#define opendir fixture_opendir
#define syscall fixture_syscall
#define MAX_TARGETS 4
#define MAX_PROCESSES 8
#define MAX_SCAN_BYTES (2 * MAX_ENV_BYTES)
#define main cleanup_main
#include "main.c"
#undef opendir
#undef syscall
#undef main

static long fixture_syscall(long number, ...) {
    assert(number == SYS_pidfd_send_signal);
    va_list args;
    va_start(args, number);
    int fd = va_arg(args, int);
    int sig = va_arg(args, int);
    assert(va_arg(args, void *) == NULL);
    assert(va_arg(args, int) == 0);
    va_end(args);
    struct stat file;
    assert(fstat(fd, &file) == 0);
    if (expected_inode) assert(file.st_ino == expected_inode);
    ++signals_seen;
    last_signal = sig;
    if (signal_error) {
        errno = signal_error;
        return -1;
    }
    return 0;
}

static struct cleanup state_for(const char *marker) {
    struct cleanup state = {0};
    snprintf(state.marker, sizeof(state.marker), MARKER_PREFIX "%s", marker);
    state.marker_length = strlen(state.marker);
    state.deadline = monotonic_seconds() + 1;
    return state;
}

static void write_environment(int target, const char *bytes, size_t length) {
    int fd = openat(target, "environ", O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    assert(fd >= 0);
    assert(write(fd, bytes, length) == (ssize_t)length);
    close(fd);
}

int main(void) {
    char marker[] = "00112233-4455-6677-8899-aabbccddeeff";
    assert(valid_marker(marker));
    assert(!valid_marker(""));
    assert(!valid_marker("00112233-4455-6677-8899-aabbccddeefg"));
    assert(!valid_marker("00112233-4455-6677-8899-aabbccddeeffx"));
    assert(process_name("1234"));
    assert(!process_name("-1234"));
    assert(!process_name("self"));
    assert(!process_name(""));
    struct cleanup state = state_for(marker);
    char exact[128];
    int length = snprintf(exact, sizeof(exact), MARKER_PREFIX "%s", marker) + 1;
    assert(matches_marker(exact, (size_t)length, &state));
    assert(!matches_marker(exact, (size_t)length - 1, &state));
    char fake[160];
    int fake_length = snprintf(fake, sizeof(fake), "X=bad\n%s", exact) + 1;
    assert(!matches_marker(fake, (size_t)fake_length, &state));
    fake_length = snprintf(fake, sizeof(fake), "%s-suffix", exact) + 1;
    assert(!matches_marker(fake, (size_t)fake_length, &state));

    char temporary[] = "/tmp/orca-guest-kill-test-XXXXXX";
    fixture_root = mkdtemp(temporary);
    assert(fixture_root);
    int root = open(fixture_root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(root >= 0 && mkdirat(root, "1234", 0700) == 0);
    int original = openat(root, "1234", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(original >= 0);
    struct stat identity;
    assert(fstat(original, &identity) == 0);
    expected_inode = identity.st_ino;
    write_environment(original, exact, (size_t)length);

    assert(inspect_process(&state, root, "1234", SIGTERM, state.deadline) == (size_t)length);
    assert(signals_seen == 1 && last_signal == SIGTERM && state.target_count == 1);
    /* Replacing the numeric directory must not replace the retained signal target. */
    assert(renameat(root, "1234", root, "old") == 0);
    assert(mkdirat(root, "1234", 0700) == 0);
    kill_captured(&state);
    assert(signals_seen == 2 && last_signal == SIGKILL && state.target_count == 0);
    expected_inode = 0;

    state = state_for(marker);
    signal_error = ESRCH;
    inspect_process(&state, root, "old", SIGTERM, state.deadline);
    assert(!state.unverifiable && state.target_count == 0);
    signal_error = EPERM;
    inspect_process(&state, root, "old", SIGTERM, state.deadline);
    assert(state.unverifiable && state.target_count == 0);
    signal_error = 0;

    state = state_for(marker);
    int before = signals_seen;
    inspect_process(&state, root, "old", SIGTERM, monotonic_seconds() - 1);
    assert(state.unverifiable && signals_seen == before);
    state = state_for(marker);
    inspect_process(&state, root, "gone", SIGTERM, state.deadline);
    assert(!state.unverifiable && signals_seen == before);

    char oversized[MAX_ENV_BYTES + 1];
    memset(oversized, 'x', sizeof(oversized));
    memcpy(oversized, exact, (size_t)length);
    write_environment(original, oversized, sizeof(oversized));
    inspect_process(&state, root, "old", SIGTERM, state.deadline);
    assert(state.unverifiable && signals_seen == before);

    write_environment(original, exact, (size_t)length);
    state = state_for(marker);
    before = signals_seen;
    for (int i = 0; i <= MAX_TARGETS; ++i) inspect_process(&state, root, "old", SIGTERM, state.deadline);
    assert(state.unverifiable && state.target_count == MAX_TARGETS);
    assert(signals_seen == before + MAX_TARGETS);
    kill_captured(&state);
    assert(signals_seen == before + 2 * MAX_TARGETS);
    state = state_for(marker);
    before = signals_seen;
    for (int i = 0; i <= MAX_TARGETS; ++i) inspect_process(&state, root, "old", SIGKILL, state.deadline);
    assert(state.unverifiable && state.target_count == 0);
    assert(signals_seen == before + MAX_TARGETS);

    for (int i = 0; i <= MAX_PROCESSES; ++i) {
        char name[32];
        snprintf(name, sizeof(name), "%d", 2000000 + i);
        assert(mkdirat(root, name, 0700) == 0);
        int fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        assert(fd >= 0);
        write_environment(fd, "", 0);
        close(fd);
    }
    state = state_for(marker);
    before = signals_seen;
    scan(&state, SIGKILL, state.deadline);
    assert(state.unverifiable && signals_seen == before);
    for (int i = 0; i <= MAX_PROCESSES; ++i) {
        char name[32];
        snprintf(name, sizeof(name), "%d", 2000000 + i);
        int fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        assert(fd >= 0 && unlinkat(fd, "environ", 0) == 0);
        close(fd);
        assert(unlinkat(root, name, AT_REMOVEDIR) == 0);
    }

    memset(oversized, 'x', MAX_ENV_BYTES);
    for (int i = 0; i < 3; ++i) {
        char name[32];
        snprintf(name, sizeof(name), "%d", 2000000 + i);
        assert(mkdirat(root, name, 0700) == 0);
        int fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        assert(fd >= 0);
        write_environment(fd, oversized, MAX_ENV_BYTES);
        close(fd);
    }
    state = state_for(marker);
    before = signals_seen;
    scan(&state, SIGKILL, state.deadline);
    assert(state.unverifiable && signals_seen == before);
    for (int i = 0; i < 3; ++i) {
        char name[32];
        snprintf(name, sizeof(name), "%d", 2000000 + i);
        int fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        assert(fd >= 0 && unlinkat(fd, "environ", 0) == 0);
        close(fd);
        assert(unlinkat(root, name, AT_REMOVEDIR) == 0);
    }

    state = state_for(marker);
    fixture_root = "/definitely/absent/orca-proc";
    scan(&state, SIGTERM, state.deadline);
    assert(state.unverifiable);
    /* Scan failure does not prevent escalation of a previously retained target. */
    state.targets[state.target_count++] = dup(original);
    kill_captured(&state);
    assert(signals_seen == before + 1 && last_signal == SIGKILL);
    assert(run_cleanup(marker, 0.1) == 2);
    request_stop(SIGTERM);
    assert(!within_deadline(monotonic_seconds() + 1));
    stopping = 0;
    wait_grace(monotonic_seconds() - 1);

    assert(unlinkat(original, "environ", 0) == 0);
    close(original);
    assert(unlinkat(root, "old", AT_REMOVEDIR) == 0);
    assert(unlinkat(root, "1234", AT_REMOVEDIR) == 0);
    close(root);
    assert(rmdir(temporary) == 0);
    signal_error = ENOSYS;
    int before_scan = scans_seen;
    char *arguments[] = { "helper", marker, "600" };
    assert(cleanup_main(3, arguments) == 3);
    assert(scans_seen == before_scan);
    signal_error = 0;
    puts("native ownership and failure checks passed");
    return 0;
}
