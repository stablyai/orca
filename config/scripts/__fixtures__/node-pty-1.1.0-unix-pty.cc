/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2017, Daniel Imms (MIT License)
 *
 * pty.cc:
 *   This file is responsible for starting processes
 *   with pseudo-terminal file descriptors.
 *
 * See:
 *   man pty
 *   man tty_ioctl
 *   man termios
 *   man forkpty
 */

/**
 * Includes
 */

#define NODE_ADDON_API_DISABLE_DEPRECATED
#include <napi.h>
#include <assert.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <thread>

#include <sys/types.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>

/* forkpty */
/* http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html */
#if defined(__linux__)
#include <pty.h>
#elif defined(__APPLE__)
#include <util.h>
#elif defined(__FreeBSD__)
#include <libutil.h>
#include <termios.h>
#elif defined(__OpenBSD__)
#include <util.h>
#include <termios.h>
#endif

/* Some platforms name VWERASE and VDISCARD differently */
#if !defined(VWERASE) && defined(VWERSE)
#define VWERASE	VWERSE
#endif
#if !defined(VDISCARD) && defined(VDISCRD)
#define VDISCARD	VDISCRD
#endif

/* for pty_getproc */
#if defined(__linux__)
#include <stdio.h>
#include <stdint.h>
#elif defined(__APPLE__)
#include <libproc.h>
#include <os/availability.h>
#include <paths.h>
#include <spawn.h>
#include <sys/event.h>
#include <sys/sysctl.h>
#include <termios.h>
#endif

/* NSIG - macro for highest signal + 1, should be defined */
#ifndef NSIG
#define NSIG 32
#endif

/* macOS 10.14 back does not define this constant */
#ifndef POSIX_SPAWN_SETSID
  #define POSIX_SPAWN_SETSID 1024
#endif

/* environ for execvpe */
/* node/src/node_child_process.cc */
#if !defined(__APPLE__)
extern char **environ;
#endif

#if defined(__APPLE__)
extern "C" {
// Changes the current thread's directory to a path or directory file
// descriptor. libpthread only exposes a syscall wrapper starting in
// macOS 10.12, but the system call dates back to macOS 10.5. On older OSes,
// the syscall is issued directly.
int pthread_chdir_np(const char* dir) API_AVAILABLE(macosx(10.12));
int pthread_fchdir_np(int fd) API_AVAILABLE(macosx(10.12));
}

#define HANDLE_EINTR(x) ({ \
  int eintr_wrapper_counter = 0; \
  decltype(x) eintr_wrapper_result; \
  do { \
    eintr_wrapper_result = (x); \
  } while (eintr_wrapper_result == -1 && errno == EINTR && \
           eintr_wrapper_counter++ < 100); \
  eintr_wrapper_result; \
})
#endif

struct ExitEvent {
  int exit_code = 0, signal_code = 0;
};

void SetupExitCallback(Napi::Env env, Napi::Function cb, pid_t pid) {
  std::thread *th = new std::thread;
  // Don't use Napi::AsyncWorker which is limited by UV_THREADPOOL_SIZE.
  auto tsfn = Napi::ThreadSafeFunction::New(
      env,
      cb,                           // JavaScript function called asynchronously
      "SetupExitCallback_resource", // Name
      0,                            // Unlimited queue
      1,                            // Only one thread will use this initially
      [th](Napi::Env) {   // Finalizer used to clean threads up
        th->join();
        delete th;
      });
  *th = std::thread([tsfn = std::move(tsfn), pid] {
    auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *exit_event) {
      cb.Call({Napi::Number::New(env, exit_event->exit_code),
               Napi::Number::New(env, exit_event->signal_code)});
      delete exit_event;
    };

    int ret;
    int stat_loc;
#if defined(__APPLE__)
    // Based on
    // https://source.chromium.org/chromium/chromium/src/+/main:base/process/kill_mac.cc;l=35-69?
    int kq = HANDLE_EINTR(kqueue());
    struct kevent change = {0};
    EV_SET(&change, pid, EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, NULL);
    ret = HANDLE_EINTR(kevent(kq, &change, 1, NULL, 0, NULL));
    if (ret == -1) {
      if (errno == ESRCH) {
        // At this point, one of the following has occurred:
        // 1. The process has died but has not yet been reaped.
        // 2. The process has died and has already been reaped.
        // 3. The process is in the process of dying. It's no longer
        //    kqueueable, but it may not be waitable yet either. Mark calls
        //    this case the "zombie death race".
        ret = HANDLE_EINTR(waitpid(pid, &stat_loc, WNOHANG));
        if (ret == 0) {
          ret = kill(pid, SIGKILL);
          if (ret != -1) {
            HANDLE_EINTR(waitpid(pid, &stat_loc, 0));
          }
        }
      }
    } else {
      struct kevent event = {0};
      ret = HANDLE_EINTR(kevent(kq, NULL, 0, &event, 1, NULL));
      if (ret == 1) {
        if ((event.fflags & NOTE_EXIT) &&
            (event.ident == static_cast<uintptr_t>(pid))) {
          // The process is dead or dying. This won't block for long, if at
          // all.
          HANDLE_EINTR(waitpid(pid, &stat_loc, 0));
        }
      }
    }
#else
    while (true) {
      errno = 0;
      if ((ret = waitpid(pid, &stat_loc, 0)) != pid) {
        if (ret == -1 && errno == EINTR) {
          continue;
        }
        if (ret == -1 && errno == ECHILD) {
          // XXX node v0.8.x seems to have this problem.
          // waitpid is already handled elsewhere.
          ;
        } else {
          assert(false);
        }
      }
      break;
    }
#endif
    ExitEvent *exit_event = new ExitEvent;
    if (WIFEXITED(stat_loc)) {
      exit_event->exit_code = WEXITSTATUS(stat_loc); // errno?
    }
    if (WIFSIGNALED(stat_loc)) {
      exit_event->signal_code = WTERMSIG(stat_loc);
    }
    auto status = tsfn.BlockingCall(exit_event, callback); // In main thread
    switch (status) {
      case napi_closing:
        break;

      case napi_queue_full:
        Napi::Error::Fatal("SetupExitCallback", "Queue was full");

      case napi_ok:
        if (tsfn.Release() != napi_ok) {
          Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.Release() failed");
        }
        break;

      default:
        Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.BlockingCall() failed");
    }
  });
}

/**
 * Methods
 */

Napi::Value PtyFork(const Napi::CallbackInfo& info);
Napi::Value PtyOpen(const Napi::CallbackInfo& info);
Napi::Value PtyResize(const Napi::CallbackInfo& info);
Napi::Value PtyGetProc(const Napi::CallbackInfo& info);

/**
 * Functions
 */

static int
pty_nonblock(int);

#if defined(__APPLE__)
static char *
pty_getproc(int);
#else
static char *
pty_getproc(int, char *);
#endif

#if defined(__APPLE__) || defined(__OpenBSD__)
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err);
#endif

struct DelBuf {
  int len;
  DelBuf(int len) : len(len) {}
  void operator()(char **p) {
    if (p == nullptr)
      return;
    for (int i = 0; i < len; i++)
      free(p[i]);
    delete[] p;
  }
};

Napi::Value PtyFork(const Napi::CallbackInfo& info) {
  Napi::Env napiEnv(info.Env());
  Napi::HandleScope scope(napiEnv);

  if (info.Length() != 11 ||
      !info[0].IsString() ||
      !info[1].IsArray() ||
      !info[2].IsArray() ||
      !info[3].IsString() ||
      !info[4].IsNumber() ||
      !info[5].IsNumber() ||
      !info[6].IsNumber() ||
      !info[7].IsNumber() ||
      !info[8].IsBoolean() ||
      !info[9].IsString() ||
      !info[10].IsFunction()) {
    throw Napi::Error::New(napiEnv, "Usage: pty.fork(file, args, env, cwd, cols, rows, uid, gid, utf8, helperPath, onexit)");
  }

  // file
  std::string file = info[0].As<Napi::String>();

  // args
  Napi::Array argv_ = info[1].As<Napi::Array>();

  // env
  Napi::Array env_ = info[2].As<Napi::Array>();
  int envc = env_.Length();
  std::unique_ptr<char *, DelBuf> env_unique_ptr(new char *[envc + 1], DelBuf(envc + 1));
  char **env = env_unique_ptr.get();
  env[envc] = NULL;
  for (int i = 0; i < envc; i++) {
    std::string pair = env_.Get(i).As<Napi::String>();
    env[i] = strdup(pair.c_str());
  }

  // cwd
  std::string cwd_ = info[3].As<Napi::String>();

  // size
  struct winsize winp;
  winp.ws_col = info[4].As<Napi::Number>().Int32Value();
  winp.ws_row = info[5].As<Napi::Number>().Int32Value();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

#if !defined(__APPLE__)
  // uid / gid
  int uid = info[6].As<Napi::Number>().Int32Value();
  int gid = info[7].As<Napi::Number>().Int32Value();
#endif

  // termios
  struct termios t = termios();
  struct termios *term = &t;
  term->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT;
  if (info[8].As<Napi::Boolean>().Value()) {
#if defined(IUTF8)
    term->c_iflag |= IUTF8;
#endif
  }
  term->c_oflag = OPOST | ONLCR;
  term->c_cflag = CREAD | CS8 | HUPCL;
  term->c_lflag = ICANON | ISIG | IEXTEN | ECHO | ECHOE | ECHOK | ECHOKE | ECHOCTL;

  term->c_cc[VEOF] = 4;
  term->c_cc[VEOL] = -1;
  term->c_cc[VEOL2] = -1;
  term->c_cc[VERASE] = 0x7f;
  term->c_cc[VWERASE] = 23;
  term->c_cc[VKILL] = 21;
  term->c_cc[VREPRINT] = 18;
  term->c_cc[VINTR] = 3;
  term->c_cc[VQUIT] = 0x1c;
  term->c_cc[VSUSP] = 26;
  term->c_cc[VSTART] = 17;
  term->c_cc[VSTOP] = 19;
  term->c_cc[VLNEXT] = 22;
  term->c_cc[VDISCARD] = 15;
  term->c_cc[VMIN] = 1;
  term->c_cc[VTIME] = 0;

  #if (__APPLE__)
  term->c_cc[VDSUSP] = 25;
  term->c_cc[VSTATUS] = 20;
  #endif

  cfsetispeed(term, B38400);
  cfsetospeed(term, B38400);

  // helperPath
  std::string helper_path = info[9].As<Napi::String>();

  pid_t pid;
  int master;
#if defined(__APPLE__)
  int argc = argv_.Length();
  int argl = argc + 4;
  std::unique_ptr<char *, DelBuf> argv_unique_ptr(new char *[argl], DelBuf(argl));
  char **argv = argv_unique_ptr.get();
  argv[0] = strdup(helper_path.c_str());
  argv[1] = strdup(cwd_.c_str());
  argv[2] = strdup(file.c_str());
  argv[argl - 1] = NULL;
  for (int i = 0; i < argc; i++) {
    std::string arg = argv_.Get(i).As<Napi::String>();
    argv[i + 3] = strdup(arg.c_str());
  }

  int err = -1;
  pty_posix_spawn(argv, env, term, &winp, &master, &pid, &err);
  if (err != 0) {
    throw Napi::Error::New(napiEnv, "posix_spawnp failed.");
  }
  if (pty_nonblock(master) == -1) {
    throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
  }
#else
  int argc = argv_.Length();
  int argl = argc + 2;
  std::unique_ptr<char *, DelBuf> argv_unique_ptr(new char *[argl], DelBuf(argl));
  char** argv = argv_unique_ptr.get();
  argv[0] = strdup(file.c_str());
  argv[argl - 1] = NULL;
  for (int i = 0; i < argc; i++) {
    std::string arg = argv_.Get(i).As<Napi::String>();
    argv[i + 1] = strdup(arg.c_str());
  }

  sigset_t newmask, oldmask;
  struct sigaction sig_action;
  // temporarily block all signals
  // this is needed due to a race condition in openpty
  // and to avoid running signal handlers in the child
  // before exec* happened
  sigfillset(&newmask);
  pthread_sigmask(SIG_SETMASK, &newmask, &oldmask);

  pid = forkpty(&master, nullptr, static_cast<termios*>(term), static_cast<winsize*>(&winp));

  if (!pid) {
    // remove all signal handler from child
    sig_action.sa_handler = SIG_DFL;
    sig_action.sa_flags = 0;
    sigemptyset(&sig_action.sa_mask);
    for (int i = 0 ; i < NSIG ; i++) {    // NSIG is a macro for all signals + 1
      sigaction(i, &sig_action, NULL);
    }
  }

  // reenable signals
  pthread_sigmask(SIG_SETMASK, &oldmask, NULL);

  switch (pid) {
    case -1:
      throw Napi::Error::New(napiEnv, "forkpty(3) failed.");
    case 0:
      if (strlen(cwd_.c_str())) {
        if (chdir(cwd_.c_str()) == -1) {
          perror("chdir(2) failed.");
          _exit(1);
        }
      }

      if (uid != -1 && gid != -1) {
        if (setgid(gid) == -1) {
          perror("setgid(2) failed.");
          _exit(1);
        }
        if (setuid(uid) == -1) {
          perror("setuid(2) failed.");
          _exit(1);
        }
      }

      {
        char **old = environ;
        environ = env;
        execvp(argv[0], argv);
        environ = old;
        perror("execvp(3) failed.");
        _exit(1);
      }
    default:
      if (pty_nonblock(master) == -1) {
        throw Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.");
      }
  }
#endif

  Napi::Object obj = Napi::Object::New(napiEnv);
  obj.Set("fd", Napi::Number::New(napiEnv, master));
  obj.Set("pid", Napi::Number::New(napiEnv, pid));
  obj.Set("pty", Napi::String::New(napiEnv, ptsname(master)));

  // Set up process exit callback.
  Napi::Function cb = info[10].As<Napi::Function>();
  SetupExitCallback(napiEnv, cb, pid);
  return obj;
}

Napi::Value PtyOpen(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.open(cols, rows)");
  }

  // size
  struct winsize winp;
  winp.ws_col = info[0].As<Napi::Number>().Int32Value();
  winp.ws_row = info[1].As<Napi::Number>().Int32Value();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  // pty
  int master, slave;
  int ret = openpty(&master, &slave, nullptr, NULL, static_cast<winsize*>(&winp));

  if (ret == -1) {
    throw Napi::Error::New(env, "openpty(3) failed.");
  }

  if (pty_nonblock(master) == -1) {
    throw Napi::Error::New(env, "Could not set master fd to nonblocking.");
  }

  if (pty_nonblock(slave) == -1) {
    throw Napi::Error::New(env, "Could not set slave fd to nonblocking.");
  }

  Napi::Object obj = Napi::Object::New(env);
  obj.Set("master", Napi::Number::New(env, master));
  obj.Set("slave", Napi::Number::New(env, slave));
  obj.Set("pty", Napi::String::New(env, ptsname(master)));

  return obj;
}

Napi::Value PtyResize(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 3 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.resize(fd, cols, rows)");
  }

  int fd = info[0].As<Napi::Number>().Int32Value();

  struct winsize winp;
  winp.ws_col = info[1].As<Napi::Number>().Int32Value();
  winp.ws_row = info[2].As<Napi::Number>().Int32Value();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  if (ioctl(fd, TIOCSWINSZ, &winp) == -1) {
    switch (errno) {
      case EBADF:
        throw Napi::Error::New(env, "ioctl(2) failed, EBADF");
      case EFAULT:
        throw Napi::Error::New(env, "ioctl(2) failed, EFAULT");
      case EINVAL:
        throw Napi::Error::New(env, "ioctl(2) failed, EINVAL");
      case ENOTTY:
        throw Napi::Error::New(env, "ioctl(2) failed, ENOTTY");
    }
    throw Napi::Error::New(env, "ioctl(2) failed");
  }

  return env.Undefined();
}

/**
 * Foreground Process Name
 */
Napi::Value PtyGetProc(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

#if defined(__APPLE__)
  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.process(pid)");
  }

  int fd = info[0].As<Napi::Number>().Int32Value();
  char *name = pty_getproc(fd);
#else
  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsString()) {
    throw Napi::Error::New(env, "Usage: pty.process(fd, tty)");
  }

  int fd = info[0].As<Napi::Number>().Int32Value();

  std::string tty_ = info[1].As<Napi::String>();
  char *tty = strdup(tty_.c_str());
  char *name = pty_getproc(fd, tty);
  free(tty);
#endif

  if (name == NULL) {
    return env.Undefined();
  }

  Napi::String name_ = Napi::String::New(env, name);
  free(name);
  return name_;
}

/**
 * Nonblocking FD
 */

static int
pty_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/**
 * pty_getproc
 * Taken from tmux.
 */

// Taken from: tmux (http://tmux.sourceforge.net/)
// Copyright (c) 2009 Nicholas Marriott <nicm@users.sourceforge.net>
// Copyright (c) 2009 Joshua Elsasser <josh@elsasser.org>
// Copyright (c) 2009 Todd Carson <toc@daybefore.net>
//
// Permission to use, copy, modify, and distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF MIND, USE, DATA OR PROFITS, WHETHER
// IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
// OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

#if defined(__linux__)

static char *
pty_getproc(int fd, char *tty) {
  FILE *f;
  char *path, *buf;
  size_t len;
  int ch;
  pid_t pgrp;
  int r;

  if ((pgrp = tcgetpgrp(fd)) == -1) {
    return NULL;
  }

  r = asprintf(&path, "/proc/%lld/cmdline", (long long)pgrp);
  if (r == -1 || path == NULL) return NULL;

  if ((f = fopen(path, "r")) == NULL) {
    free(path);
    return NULL;
  }

  free(path);

  len = 0;
  buf = NULL;
  while ((ch = fgetc(f)) != EOF) {
    if (ch == '\0') break;
    buf = (char *)realloc(buf, len + 2);
    if (buf == NULL) return NULL;
    buf[len++] = ch;
  }

  if (buf != NULL) {
    buf[len] = '\0';
  }

  fclose(f);
  return buf;
}

#elif defined(__APPLE__)

static char *
pty_getproc(int fd) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, 0 };
  size_t size;
  struct kinfo_proc kp;

  if ((mib[3] = tcgetpgrp(fd)) == -1) {
    return NULL;
  }

  size = sizeof kp;
  if (sysctl(mib, 4, &kp, &size, NULL, 0) == -1) {
    return NULL;
  }

  if (size != (sizeof kp) || *kp.kp_proc.p_comm == '\0') {
    return NULL;
  }

  return strdup(kp.kp_proc.p_comm);
}

#else

static char *
pty_getproc(int fd, char *tty) {
  return NULL;
}

#endif

#if defined(__APPLE__)
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err) {
  int low_fds[3];
  size_t count = 0;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }

  int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
              POSIX_SPAWN_SETSIGDEF |
              POSIX_SPAWN_SETSIGMASK |
              POSIX_SPAWN_SETSID;
  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    return;
  }

  int res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    return;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  int slave;
  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    return;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    return;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      return;
    };
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      return;
    }
  }

  posix_spawn_file_actions_t acts;
  posix_spawn_file_actions_init(&acts);
  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&acts, slave);
  posix_spawn_file_actions_addclose(&acts, *master);

  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  *err = posix_spawnattr_setflags(&attrs, flags);
  if (*err != 0) {
    goto done;
  }

  sigset_t signal_set;
  /* Reset all signal the child to their default behavior */
  sigfillset(&signal_set);
  *err = posix_spawnattr_setsigdefault(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  /* Reset the signal mask for all signals */
  sigemptyset(&signal_set);
  *err = posix_spawnattr_setsigmask(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}
#endif

/**
 * Init
 */

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("fork",    Napi::Function::New(env, PtyFork));
  exports.Set("open",    Napi::Function::New(env, PtyOpen));
  exports.Set("resize",  Napi::Function::New(env, PtyResize));
  exports.Set("process", Napi::Function::New(env, PtyGetProc));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init)
