#pragma once
#include <cstdint>
#include <memory>
#include <utility>
#include <string>
#include <vector>

namespace history {
// Not a std::runtime_error: its move constructor is a GLIBCXX_3.4.26 symbol, above the Linux slot floor.
struct Failure {
  std::string operation;
  std::string code;
  int nativeCode;
  Failure(const char* op, std::string code, int nativeCode) : operation(op), code(std::move(code)), nativeCode(nativeCode) {}
  std::string message() const { return operation + ": " + code; }
};
enum class Kind { Missing, Directory, File, Link, Other };
enum class Move { Moved, Collision, Missing };
class Directory {
 public:
  explicit Directory(intptr_t handle) : handle_(handle) {}
  ~Directory() { close(); }
  Directory(const Directory&) = delete;
  Directory& operator=(const Directory&) = delete;
  static std::unique_ptr<Directory> root(const std::string& path, bool follow);
  std::unique_ptr<Directory> open(const std::string& name);
  std::vector<std::string> entries();
  Kind kind(const std::string& name);
  void mkdir(const std::string& name, Directory* like = nullptr);
  Move move(const std::string& name, Directory& destination, const std::string& target, bool directoryOnly = false);
  void link(const std::string& name, const std::string& target);
  std::string readLink(const std::string& name);
  void removeEmpty(const std::string& name);
  std::string read(const std::string& name);
  void write(const std::string& name, const std::string& data, bool create);
  void unlink(const std::string& name);
  std::string identity(const std::string& name);
  bool same(Directory& other);
  bool sameDevice(Directory& other);
  void close();
  intptr_t handle() const {
    if (handle_ == -1) throw Failure("directory", "EBADF", 0);
    return handle_;
  }
 private:
  intptr_t handle_;
};
}
