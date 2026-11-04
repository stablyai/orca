// libuv spawns with bInheritHandles=TRUE and no handle list, so every inheritable handle in Orca
// reaches a long-lived child. This spawn lists exactly one NUL handle, used for all three stdio.
// Flags mirror libuv's detached spawn; no PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, no breakaway.

#include "isolated-spawn.h"

#include <windows.h>

#include <string>
#include <vector>

namespace {

struct ExitWatch {
  HANDLE process = nullptr;
  HANDLE wait = nullptr;
  Napi::ThreadSafeFunction onExit;
};

// Runs on a wait thread once the process is signaled; hands the code to the JS thread.
void CALLBACK OnProcessExited(PVOID context, BOOLEAN /*timedOut*/) {
  auto* watch = static_cast<ExitWatch*>(context);
  DWORD code = 0;
  if (!GetExitCodeProcess(watch->process, &code)) {
    code = static_cast<DWORD>(-1);
  }
  watch->onExit.NonBlockingCall([watch, code](Napi::Env env, Napi::Function callback) {
    // Non-blocking unregister: the callback already ran once (WT_EXECUTEONLYONCE).
    UnregisterWait(watch->wait);
    CloseHandle(watch->process);
    if (env != nullptr && !callback.IsEmpty()) {
      callback.Call({Napi::Number::New(env, static_cast<double>(code))});
    }
    watch->onExit.Release();
    delete watch;
  });
}

Napi::Value ThrowWin32(Napi::Env env, const char* syscall, DWORD code) {
  Napi::Error::New(env, std::string(syscall) + " failed with Win32 error " + std::to_string(code))
      .ThrowAsJavaScriptException();
  return env.Undefined();
}

}  // namespace

// spawnDetachedIsolated(file, commandLine, cwd, environmentBlock, onExit(code)) -> { pid, exitWatchError }
// The exit callback never keeps the event loop alive.
Napi::Value SpawnDetachedIsolated(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 5 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString() ||
      !info[3].IsString() || !info[4].IsFunction()) {
    Napi::TypeError::New(
        env, "spawnDetachedIsolated(file, commandLine, cwd, environmentBlock, onExit) expected")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::u16string file = info[0].As<Napi::String>().Utf16Value();
  std::u16string commandLine = info[1].As<Napi::String>().Utf16Value();
  std::u16string cwd = info[2].As<Napi::String>().Utf16Value();
  std::u16string environment = info[3].As<Napi::String>().Utf16Value();

  SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           &inheritable, OPEN_EXISTING, 0, nullptr);
  if (nul == INVALID_HANDLE_VALUE) {
    return ThrowWin32(env, "CreateFileW", GetLastError());
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<unsigned char> storage(size);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &size)) {
    DWORD error = GetLastError();
    CloseHandle(nul);
    return ThrowWin32(env, "InitializeProcThreadAttributeList", error);
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &nul, sizeof(nul),
                                 nullptr, nullptr)) {
    DWORD error = GetLastError();
    DeleteProcThreadAttributeList(attributes);
    CloseHandle(nul);
    return ThrowWin32(env, "UpdateProcThreadAttribute", error);
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = nul;
  startup.StartupInfo.hStdOutput = nul;
  startup.StartupInfo.hStdError = nul;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION created{};
  const DWORD flags = CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP |
                      EXTENDED_STARTUPINFO_PRESENT;
  BOOL ok = CreateProcessW(reinterpret_cast<LPCWSTR>(file.c_str()),
                           reinterpret_cast<LPWSTR>(commandLine.data()), nullptr, nullptr, TRUE,
                           flags, environment.data(),
                           cwd.empty() ? nullptr : reinterpret_cast<LPCWSTR>(cwd.c_str()),
                           &startup.StartupInfo, &created);
  DWORD error = GetLastError();
  DeleteProcThreadAttributeList(attributes);
  CloseHandle(nul);
  if (!ok) {
    return ThrowWin32(env, "CreateProcessW", error);
  }
  CloseHandle(created.hThread);

  auto result = Napi::Object::New(env);
  result.Set("pid", static_cast<double>(created.dwProcessId));
  auto* watch = new ExitWatch{created.hProcess};
  watch->onExit = Napi::ThreadSafeFunction::New(env, info[4].As<Napi::Function>(),
                                                "orcaIsolatedSpawnExit", 0, 1);
  watch->onExit.Unref(env);
  if (!RegisterWaitForSingleObject(&watch->wait, created.hProcess, OnProcessExited, watch, INFINITE,
                                   WT_EXECUTEONLYONCE)) {
    // The child runs on; only its exit goes unobserved.
    result.Set("exitWatchError", static_cast<double>(GetLastError()));
    watch->onExit.Release();
    CloseHandle(created.hProcess);
    delete watch;
    return result;
  }
  result.Set("exitWatchError", env.Null());
  return result;
}
