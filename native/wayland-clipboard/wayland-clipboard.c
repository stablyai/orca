#define _POSIX_C_SOURCE 200809L
#include <wayland-client.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_TEXT_BYTES (16 * 1024 * 1024)
#define MAX_TRANSFERS 8
#define TRANSFER_TIMEOUT_MS 2000

// Load the desktop's Wayland library without introducing a build-time target-library dependency.
static struct {
    struct wl_display *(*connect)(const char *);
    int (*roundtrip)(struct wl_display *);
    int (*get_fd)(struct wl_display *);
    int (*prepare_read)(struct wl_display *);
    void (*cancel_read)(struct wl_display *);
    int (*read_events)(struct wl_display *);
    int (*dispatch_pending)(struct wl_display *);
    int (*flush)(struct wl_display *);
    struct wl_proxy *(*construct)(struct wl_proxy *, uint32_t, union wl_argument *,
                                 const struct wl_interface *, uint32_t);
    void (*marshal)(struct wl_proxy *, uint32_t, union wl_argument *);
    int (*listen)(struct wl_proxy *, void (**)(void), void *);
    void (*destroy)(struct wl_proxy *);
    const struct wl_interface *registry_interface;
    const struct wl_interface *seat_interface;
} api;

static struct wl_interface manager_interface, source_interface, device_interface, offer_interface;
static const struct wl_interface *manager_source_types[] = { &source_interface };
static const struct wl_interface *manager_device_types[] = { &device_interface, NULL };
static const struct wl_interface *device_source_types[] = { &source_interface };
static const struct wl_interface *device_offer_types[] = { &offer_interface };
static const struct wl_message manager_methods[] = {
    { "create_data_source", "n", manager_source_types },
    { "get_data_device", "no", manager_device_types },
    { "destroy", "", NULL }
};
static const struct wl_message source_methods[] = {
    { "offer", "s", NULL }, { "destroy", "", NULL }
};
static const struct wl_message source_events[] = {
    { "send", "sh", NULL }, { "cancelled", "", NULL }
};
static const struct wl_message device_methods[] = {
    { "set_selection", "?o", device_source_types }, { "destroy", "", NULL },
    { "set_primary_selection", "?o", device_source_types }
};
static const struct wl_message device_events[] = {
    { "data_offer", "n", device_offer_types },
    { "selection", "?o", device_offer_types }, { "finished", "", NULL },
    { "primary_selection", "?o", device_offer_types }
};
static const struct wl_message offer_methods[] = {
    { "receive", "sh", NULL }, { "destroy", "", NULL }
};
static const struct wl_message offer_events[] = { { "offer", "s", NULL } };

static uint32_t ext_manager_name, wlr_manager_name, seat_name;
static bool stopped, source_cancelled, device_lost;
static unsigned char *text;
static size_t text_length;
static struct {
    int fd;
    size_t offset;
    int64_t deadline;
} transfers[MAX_TRANSFERS];

static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version) {
    (void)data; (void)registry; (void)version;
    if (strcmp(interface, "ext_data_control_manager_v1") == 0) ext_manager_name = name;
    if (strcmp(interface, "zwlr_data_control_manager_v1") == 0) wlr_manager_name = name;
    if (!seat_name && strcmp(interface, "wl_seat") == 0) seat_name = name;
}

static void registry_removed(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data; (void)registry;
    if (name == seat_name) device_lost = stopped = true;
}

static void seat_capabilities(void *data, struct wl_seat *seat, uint32_t capabilities) {
    (void)data; (void)seat; (void)capabilities;
}

static void offer_mime(void *data, struct wl_proxy *offer, const char *mime) {
    (void)data; (void)offer; (void)mime;
}

static void device_offer(void *data, struct wl_proxy *device, struct wl_proxy *offer) {
    (void)data; (void)device;
    static void (*listener[])(void) = { (void (*)(void))offer_mime };
    api.listen(offer, listener, NULL);
}

static void device_selection(void *data, struct wl_proxy *device, struct wl_proxy *offer) {
    (void)data; (void)device;
    if (offer) {
        api.marshal(offer, 1, NULL);
        api.destroy(offer);
    }
}

static void finished(void *data, struct wl_proxy *object) {
    (void)data; (void)object;
    device_lost = stopped = true;
}

static void cancelled(void *data, struct wl_proxy *object) {
    (void)data; (void)object;
    source_cancelled = stopped = true;
}

static void source_send(void *data, struct wl_proxy *source, const char *mime, int fd) {
    (void)data; (void)source; (void)mime;
    for (int i = 0; i < MAX_TRANSFERS; i++) {
        if (transfers[i].fd != -1) continue;
        int flags = fcntl(fd, F_GETFL);
        if (flags == -1 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) == -1) break;
        transfers[i].fd = fd;
        transfers[i].offset = 0;
        transfers[i].deadline = now_ms() + TRANSFER_TIMEOUT_MS;
        return;
    }
    close(fd);
}

static int load_wayland(void) {
    void *library = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!library) return -1;
#define LOAD(member, symbol) do { api.member = dlsym(library, symbol); if (!api.member) return -1; } while (0)
    LOAD(connect, "wl_display_connect");
    LOAD(roundtrip, "wl_display_roundtrip");
    LOAD(get_fd, "wl_display_get_fd");
    LOAD(prepare_read, "wl_display_prepare_read");
    LOAD(cancel_read, "wl_display_cancel_read");
    LOAD(read_events, "wl_display_read_events");
    LOAD(dispatch_pending, "wl_display_dispatch_pending");
    LOAD(flush, "wl_display_flush");
    LOAD(construct, "wl_proxy_marshal_array_constructor_versioned");
    LOAD(marshal, "wl_proxy_marshal_array");
    LOAD(listen, "wl_proxy_add_listener");
    LOAD(destroy, "wl_proxy_destroy");
    LOAD(registry_interface, "wl_registry_interface");
    LOAD(seat_interface, "wl_seat_interface");
#undef LOAD
    return 0;
}

static struct wl_proxy *bind(struct wl_proxy *registry, uint32_t name,
                             const struct wl_interface *interface) {
    union wl_argument args[] = { { .u = name }, { .s = interface->name },
                                { .u = 1 }, { .n = 0 } };
    return api.construct(registry, 0, args, interface, 1);
}

static void configure_protocol(void) {
    bool ext = ext_manager_name != 0;
    manager_interface = (struct wl_interface){
        ext ? "ext_data_control_manager_v1" : "zwlr_data_control_manager_v1",
        1, 3, manager_methods, 0, NULL
    };
    source_interface = (struct wl_interface){
        ext ? "ext_data_control_source_v1" : "zwlr_data_control_source_v1",
        1, 2, source_methods, 2, source_events
    };
    device_interface = (struct wl_interface){
        ext ? "ext_data_control_device_v1" : "zwlr_data_control_device_v1",
        1, ext ? 3 : 2, device_methods, ext ? 4 : 3, device_events
    };
    offer_interface = (struct wl_interface){
        ext ? "ext_data_control_offer_v1" : "zwlr_data_control_offer_v1",
        1, 2, offer_methods, 1, offer_events
    };
    manager_device_types[1] = api.seat_interface;
}

static int read_text(void) {
    text = malloc(MAX_TEXT_BYTES + 1);
    if (!text) return -1;
    while (text_length <= MAX_TEXT_BYTES) {
        ssize_t count = read(STDIN_FILENO, text + text_length, MAX_TEXT_BYTES + 1 - text_length);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return -1;
        if (count == 0) return 0;
        text_length += (size_t)count;
    }
    return -1;
}

static void close_transfer(int index) {
    close(transfers[index].fd);
    transfers[index].fd = -1;
}

static int serve(struct wl_display *display) {
    while (!stopped) {
        while (api.prepare_read(display) != 0) {
            if (api.dispatch_pending(display) < 0 || stopped) return 0;
        }
        struct pollfd fds[MAX_TRANSFERS + 1] = { { api.get_fd(display), POLLIN, 0 } };
        int flush_result = api.flush(display);
        if (flush_result < 0 && errno != EAGAIN) {
            api.cancel_read(display);
            return -1;
        }
        if (flush_result < 0) fds[0].events |= POLLOUT;
        int timeout = -1;
        int64_t now = now_ms();
        for (int i = 0; i < MAX_TRANSFERS; i++) {
            fds[i + 1] = (struct pollfd){ transfers[i].fd, POLLOUT, 0 };
            if (transfers[i].fd == -1) continue;
            int remaining = (int)(transfers[i].deadline - now);
            if (remaining < 0) remaining = 0;
            if (timeout == -1 || remaining < timeout) timeout = remaining;
        }
        int ready = poll(fds, MAX_TRANSFERS + 1, timeout);
        if (ready > 0 && (fds[0].revents & POLLIN)) {
            if (api.read_events(display) < 0) return -1;
        } else {
            api.cancel_read(display);
        }
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0 || (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL))) return -1;
        if (api.dispatch_pending(display) < 0) return -1;
        for (int i = 0; i < MAX_TRANSFERS; i++) {
            if (transfers[i].fd == -1) continue;
            if (now_ms() >= transfers[i].deadline ||
                (fds[i + 1].revents & (POLLERR | POLLHUP | POLLNVAL))) {
                close_transfer(i);
                continue;
            }
            if (!(fds[i + 1].revents & POLLOUT)) continue;
            size_t remaining = text_length - transfers[i].offset;
            ssize_t count = write(transfers[i].fd, text + transfers[i].offset,
                                  remaining > 65536 ? 65536 : remaining);
            if (count > 0) {
                transfers[i].offset += (size_t)count;
                transfers[i].deadline = now_ms() + TRANSFER_TIMEOUT_MS;
            }
            if (transfers[i].offset == text_length ||
                (count < 0 && errno != EAGAIN && errno != EINTR)) close_transfer(i);
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    bool probe = argc == 2 && strcmp(argv[1], "--probe") == 0;
    if (argc != 1 && !probe) return 64;
    for (int i = 0; i < MAX_TRANSFERS; i++) transfers[i].fd = -1;
    signal(SIGPIPE, SIG_IGN);
    if (load_wayland() < 0) return 69;
    struct wl_display *display = api.connect(NULL);
    if (!display) return 69;
    union wl_argument new_id[] = { { .n = 0 } };
    struct wl_proxy *registry = api.construct((struct wl_proxy *)display, 1, new_id,
                                               api.registry_interface, 1);
    if (!registry) return 70;
    static void (*registry_listener[])(void) = {
        (void (*)(void))registry_global, (void (*)(void))registry_removed
    };
    api.listen(registry, registry_listener, NULL);
    if (api.roundtrip(display) < 0) return 70;
    // No serial-based protocol or popup fallback: unsupported desktops fail without changing selection.
    if (!seat_name || (!ext_manager_name && !wlr_manager_name)) return 78;
    if (probe) return 0;
    configure_protocol();
    struct wl_proxy *seat = bind(registry, seat_name, api.seat_interface);
    struct wl_proxy *manager = bind(registry, ext_manager_name ? ext_manager_name : wlr_manager_name,
                                     &manager_interface);
    if (!seat || !manager) return 70;
    static void (*seat_listener[])(void) = { (void (*)(void))seat_capabilities };
    api.listen(seat, seat_listener, NULL);
    union wl_argument device_args[] = { { .n = 0 }, { .o = (struct wl_object *)seat } };
    struct wl_proxy *device = api.construct(manager, 1, device_args, &device_interface, 1);
    struct wl_proxy *source = api.construct(manager, 0, new_id, &source_interface, 1);
    if (!device || !source) return 70;
    static void (*device_listener[])(void) = {
        (void (*)(void))device_offer, (void (*)(void))device_selection,
        (void (*)(void))finished, (void (*)(void))device_selection
    };
    static void (*source_listener[])(void) = { (void (*)(void))source_send, (void (*)(void))cancelled };
    api.listen(device, device_listener, NULL);
    api.listen(source, source_listener, NULL);
    if (read_text() < 0) return 65;
    for (const char **mime = (const char *[]){ "text/plain;charset=utf-8", "text/plain", "UTF8_STRING", NULL };
         *mime; mime++) {
        union wl_argument args[] = { { .s = *mime } };
        api.marshal(source, 0, args);
    }
    union wl_argument selection[] = { { .o = (struct wl_object *)source } };
    api.marshal(device, 0, selection);
    if (api.roundtrip(display) < 0 || device_lost) return 70;
    // An immediate external replacement is a completed copy, not a failed publication.
    if (source_cancelled) return 0;
    int ready[2];
    if (pipe(ready) < 0) return 71;
    pid_t pid = fork();
    if (pid < 0) return 71;
    if (pid > 0) {
        close(ready[1]);
        char ack = 0;
        ssize_t count;
        do { count = read(ready[0], &ack, 1); } while (count < 0 && errno == EINTR);
        _exit(count == 1 && ack == 1 ? 0 : 71);
    }
    close(ready[0]);
    signal(SIGHUP, SIG_IGN);
    if (setsid() < 0) return 71;
    int devnull = open("/dev/null", O_RDWR);
    if (devnull < 0) return 71;
    for (int fd = 0; fd < 3; fd++) if (dup2(devnull, fd) < 0) return 71;
    if (devnull > 2) close(devnull);
    if (chdir("/") < 0) return 71;
    // Acknowledge only after the owner can survive app exit and serve pastes.
    if (write(ready[1], "\1", 1) != 1) return 71;
    close(ready[1]);
    return serve(display) < 0 ? 70 : 0;
}
