// Who owns the other end of a loopback TCP connection: the kernel's owner PID per connection,
// then that process's token user. Loopback listeners can't otherwise tell two local users apart.

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <sddl.h>

#include "connection-owner.h"

#include <cstring>
#include <vector>

namespace {

struct Endpoint {
  IN_ADDR address{};
  u_short port = 0;
};

bool ParseEndpoint(const Napi::Value& host, const Napi::Value& port, Endpoint* endpoint) {
  if (!host.IsString() || !port.IsNumber()) {
    return false;
  }
  auto value = port.As<Napi::Number>().Int64Value();
  auto text = host.As<Napi::String>().Utf16Value();
  if (value < 1 || value > 65535 ||
      InetPtonW(AF_INET, reinterpret_cast<PCWSTR>(text.c_str()), &endpoint->address) != 1) {
    return false;
  }
  endpoint->port = static_cast<u_short>(value);
  return true;
}

// Ports sit in the low 16 bits in network order.
u_short RowPort(DWORD port) { return ntohs(static_cast<u_short>(port)); }

void ToV4Mapped(const IN_ADDR& address, UCHAR mapped[16]) {
  std::memset(mapped, 0, 16);
  mapped[10] = 0xff;
  mapped[11] = 0xff;
  std::memcpy(mapped + 12, &address, 4);
}

// The table can grow between the sizing call and the read, so retry a few times.
DWORD ReadTcpTable(ULONG family, std::vector<BYTE>* buffer) {
  DWORD size = 0;
  DWORD status = ERROR_INSUFFICIENT_BUFFER;
  for (int attempt = 0; attempt < 4 && status == ERROR_INSUFFICIENT_BUFFER; attempt++) {
    buffer->resize(size);
    status = GetExtendedTcpTable(size ? buffer->data() : nullptr, &size, FALSE, family,
                                 TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
  }
  return status;
}

class TcpClientOwnerWorker : public Napi::AsyncWorker {
 public:
  TcpClientOwnerWorker(Napi::Env env, Endpoint client, Endpoint server)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), client_(client),
        server_(server) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    if (!FindOwnerPid() || pid_ == 0) {
      return;
    }
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid_);
    if (process == nullptr) {
      failedCall_ = "OpenProcess";
      code_ = GetLastError();
      return;
    }
    failedCall_ = ReadProcessUserSid(process, &sid_, &code_);
    CloseHandle(process);
  }

  // A table read failure rejects; an owner found but unreadable still reports its PID.
  void OnOK() override {
    auto env = Env();
    std::string failure = failedCall_ == nullptr
                              ? ""
                              : std::string(failedCall_) + " failed with Win32 error " +
                                    std::to_string(code_);
    if (pid_ == 0) {
      if (failedCall_ != nullptr) {
        deferred_.Reject(Napi::Error::New(env, failure).Value());
      } else {
        deferred_.Resolve(env.Null());
      }
      return;
    }
    auto owner = Napi::Object::New(env);
    owner.Set("pid", Napi::Number::New(env, static_cast<double>(pid_)));
    if (failedCall_ != nullptr) {
      owner.Set("error", Napi::String::New(env, failure));
    } else {
      owner.Set("sid", Napi::String::New(env, sid_));
    }
    deferred_.Resolve(owner);
  }

 private:
  // The connecting side's row has the client as its local end; our accepted copy is the reverse.
  // PID 0 marks TIME_WAIT rows, which no process holds any more.
  bool FindOwnerPid() {
    std::vector<BYTE> buffer;
    DWORD status = ReadTcpTable(AF_INET, &buffer);
    if (status != NO_ERROR) {
      return Fail("GetExtendedTcpTable", status);
    }
    auto* v4 = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(buffer.data());
    for (DWORD index = 0; index < v4->dwNumEntries; index++) {
      const auto& row = v4->table[index];
      if (row.dwOwningPid != 0 && row.dwLocalAddr == client_.address.S_un.S_addr &&
          RowPort(row.dwLocalPort) == client_.port &&
          row.dwRemoteAddr == server_.address.S_un.S_addr &&
          RowPort(row.dwRemotePort) == server_.port) {
        pid_ = row.dwOwningPid;
        return true;
      }
    }
    // A dual-stack client socket lists its IPv4 connection with v4-mapped addresses.
    status = ReadTcpTable(AF_INET6, &buffer);
    if (status != NO_ERROR) {
      return Fail("GetExtendedTcpTable", status);
    }
    UCHAR client[16], server[16];
    ToV4Mapped(client_.address, client);
    ToV4Mapped(server_.address, server);
    auto* v6 = reinterpret_cast<MIB_TCP6TABLE_OWNER_PID*>(buffer.data());
    for (DWORD index = 0; index < v6->dwNumEntries; index++) {
      const auto& row = v6->table[index];
      if (row.dwOwningPid != 0 && std::memcmp(row.ucLocalAddr, client, 16) == 0 &&
          RowPort(row.dwLocalPort) == client_.port &&
          std::memcmp(row.ucRemoteAddr, server, 16) == 0 &&
          RowPort(row.dwRemotePort) == server_.port) {
        pid_ = row.dwOwningPid;
        return true;
      }
    }
    return true;
  }

  bool Fail(const char* call, DWORD code) {
    failedCall_ = call;
    code_ = code;
    return false;
  }

  Napi::Promise::Deferred deferred_;
  Endpoint client_;
  Endpoint server_;
  DWORD pid_ = 0;
  std::u16string sid_;
  const char* failedCall_ = nullptr;
  DWORD code_ = ERROR_SUCCESS;
};

}  // namespace

const char* ReadProcessUserSid(void* process, std::u16string* sid, unsigned long* code) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(static_cast<HANDLE>(process), TOKEN_QUERY, &token)) {
    *code = GetLastError();
    return "OpenProcessToken";
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  BOOL queried = size > 0 && GetTokenInformation(token, TokenUser, buffer.data(), size, &size);
  DWORD queryError = GetLastError();
  CloseHandle(token);
  if (!queried) {
    *code = queryError;
    return "GetTokenInformation";
  }
  LPWSTR text = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &text)) {
    *code = GetLastError();
    return "ConvertSidToStringSidW";
  }
  sid->assign(reinterpret_cast<char16_t*>(text));
  LocalFree(text);
  return nullptr;
}

// tcpClientOwnerAsync(clientHost, clientPort, serverHost, serverPort): IPv4 only, since every
// caller's listener binds 127.0.0.1. Resolves null when no live connection matches.
Napi::Value TcpClientOwnerAsync(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  Endpoint client, server;
  if (info.Length() < 4 || !ParseEndpoint(info[0], info[1], &client) ||
      !ParseEndpoint(info[2], info[3], &server)) {
    Napi::TypeError::New(env,
                         "tcpClientOwnerAsync(clientHost: string, clientPort: number, "
                         "serverHost: string, serverPort: number) takes IPv4 hosts")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto* worker = new TcpClientOwnerWorker(env, client, server);
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}
