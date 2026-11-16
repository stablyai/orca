#define _POSIX_C_SOURCE 200809L
#include "x11-clipboard-publisher.h"
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdlib.h>
#include <unistd.h>

typedef void GtkClipboard;
typedef void GtkSelectionData;
typedef void *GdkAtom;
typedef struct { char *target; unsigned int flags; unsigned int info; } GtkTargetEntry;

static struct {
    void (*allow_backends)(const char *);
    int (*init)(int *, char ***);
    GdkAtom (*atom)(const char *);
    GtkClipboard *(*clipboard)(GdkAtom);
    int (*set_data)(GtkClipboard *, const GtkTargetEntry *, unsigned int,
                    void (*)(GtkClipboard *, GtkSelectionData *, unsigned int, void *),
                    void (*)(GtkClipboard *, void *), void *);
    GdkAtom (*target)(GtkSelectionData *);
    void (*set_selection)(GtkSelectionData *, GdkAtom, int, const unsigned char *, int);
    void *(*display)(void);
    void (*sync)(void *);
    void (*main)(void);
    void (*quit)(void);
    unsigned int (*main_level)(void);
} gtk;

static const unsigned char *contents;
static size_t contents_length;
static bool owned;

static void get_data(GtkClipboard *clipboard, GtkSelectionData *selection,
                     unsigned int info, void *data) {
    (void)clipboard; (void)info; (void)data;
    gtk.set_selection(selection, gtk.target(selection), 8, contents, (int)contents_length);
}

static void clear_data(GtkClipboard *clipboard, void *data) {
    (void)clipboard; (void)data;
    owned = false;
    if (gtk.main_level() > 0) gtk.quit();
}

static int load_gtk(void) {
    void *library = dlopen("libgtk-3.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!library) return -1;
#define LOAD(member, symbol) do { gtk.member = dlsym(library, symbol); if (!gtk.member) return -1; } while (0)
    LOAD(allow_backends, "gdk_set_allowed_backends");
    LOAD(init, "gtk_init_check");
    LOAD(atom, "gdk_atom_intern_static_string");
    LOAD(clipboard, "gtk_clipboard_get");
    LOAD(set_data, "gtk_clipboard_set_with_data");
    LOAD(target, "gtk_selection_data_get_target");
    LOAD(set_selection, "gtk_selection_data_set");
    LOAD(display, "gdk_display_get_default");
    LOAD(sync, "gdk_display_sync");
    LOAD(main, "gtk_main");
    LOAD(quit, "gtk_main_quit");
    LOAD(main_level, "gtk_main_level");
#undef LOAD
    return 0;
}

int publish_x11_clipboard(const unsigned char *text, size_t length) {
    const char *display = getenv("DISPLAY");
    if (!display || !display[0]) return 78;
    int ready[2];
    if (pipe(ready) < 0) return 71;
    pid_t pid = fork();
    if (pid < 0) { close(ready[0]); close(ready[1]); return 71; }
    if (pid > 0) {
        close(ready[1]);
        char ack = 0;
        ssize_t count;
        do { count = read(ready[0], &ack, 1); } while (count < 0 && errno == EINTR);
        close(ready[0]);
        return count == 1 && ack == 1 ? 0 : 71;
    }
    close(ready[0]);
    signal(SIGHUP, SIG_IGN);
    // Initialize GTK only in the detached owner: its threads cannot safely survive fork.
    alarm(2);
    if (setsid() < 0) _exit(71);
    int devnull = open("/dev/null", O_RDWR);
    if (devnull < 0) _exit(71);
    for (int fd = 0; fd < 3; fd++) if (dup2(devnull, fd) < 0) _exit(71);
    if (devnull > 2) close(devnull);
    if (chdir("/") < 0 || setenv("GDK_BACKEND", "x11", 1) < 0 || load_gtk() < 0) _exit(69);
    gtk.allow_backends("x11");
    if (!gtk.init(NULL, NULL)) _exit(69);
    GtkClipboard *clipboard = gtk.clipboard(gtk.atom("CLIPBOARD"));
    GtkTargetEntry targets[] = {
        { "text/plain;charset=utf-8", 0, 0 },
        { "text/plain", 0, 0 },
        { "UTF8_STRING", 0, 0 }
    };
    contents = text;
    contents_length = length;
    owned = true;
    if (!clipboard || !gtk.set_data(clipboard, targets, 3, get_data, clear_data, NULL)) _exit(70);
    gtk.sync(gtk.display());
    if (write(ready[1], "\1", 1) != 1) _exit(71);
    close(ready[1]);
    alarm(0);
    if (owned) gtk.main();
    _exit(0);
}
