#include <napi.h>
#include "history-filesystem.h"
#include <unordered_set>

namespace {
using history::Directory;
struct Lifetime {
  std::unordered_set<Directory*> directories;
  void close() { for (auto* directory : directories) directory->close(); }
};
struct Addon {
  Napi::FunctionReference constructor;
  std::shared_ptr<Lifetime> lifetime = std::make_shared<Lifetime>();
};
struct Transfer { std::unique_ptr<Directory> directory; std::shared_ptr<Lifetime> lifetime; Addon* addon; };
static Napi::Value error(Napi::Env env, const history::Failure& failure) {
  auto result = Napi::Error::New(env, failure.what());
  result.Value().Set("code", failure.code); result.Value().Set("operation", failure.operation); result.Value().Set("nativeCode", failure.nativeCode);
  result.ThrowAsJavaScriptException();
  return env.Undefined();
}
static std::string text(const Napi::CallbackInfo& info, size_t index, bool name = true) {
  if (info.Length() <= index || !info[index].IsString()) throw history::Failure("argument", "EINVAL", 0);
  std::string value = info[index].As<Napi::String>().Utf8Value();
  if (value.empty() || value.find('\0') != std::string::npos || (name && (value == "." || value == ".." || value.find('/') != std::string::npos
#ifdef _WIN32
      || value.find_first_of("\\:") != std::string::npos
#endif
      ))) throw history::Failure("entry-name", "EINVAL", 0);
  return value;
}
class Capability : public Napi::ObjectWrap<Capability> {
 public:
  static Napi::Object create(Napi::Env env, std::unique_ptr<Directory> directory, Addon* addon) {
    Transfer transfer{std::move(directory), addon->lifetime, addon};
    return addon->constructor.New({Napi::External<Transfer>::New(env, &transfer)});
  }
  Capability(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Capability>(info) {
    if (info.Length() != 1 || !info[0].IsExternal()) throw Napi::TypeError::New(info.Env(), "Private directory capability");
    auto* transfer = info[0].As<Napi::External<Transfer>>().Data();
    directory_ = std::move(transfer->directory); lifetime_ = transfer->lifetime; addon_ = transfer->addon;
    lifetime_->directories.insert(directory_.get());
  }
  ~Capability() { if (directory_) lifetime_->directories.erase(directory_.get()); }
  Directory& other(const Napi::CallbackInfo& info, size_t index) {
    auto* addon = addon_;
    if (info.Length() <= index || !info[index].IsObject() || !info[index].As<Napi::Object>().InstanceOf(addon->constructor.Value())) throw history::Failure("directory-argument", "EINVAL", 0);
    return *Unwrap(info[index].As<Napi::Object>())->directory_;
  }
  Napi::Value call(const Napi::CallbackInfo& info, const std::string& method) {
    try {
      auto env = info.Env(); auto& d = *directory_;
      if (method == "close") { d.close(); return env.Undefined(); }
      if (method == "entries") {
        auto names = d.entries(); auto array = Napi::Array::New(env, names.size());
        for (size_t i = 0; i < names.size(); i++) array.Set(static_cast<uint32_t>(i), names[i]);
        return array;
      }
      if (method == "same" || method == "sameDevice") return Napi::Boolean::New(env, method == "same" ? d.same(other(info, 0)) : d.sameDevice(other(info, 0)));
      auto name = text(info, 0);
      if (method == "open") return create(env, d.open(name), addon_);
      if (method == "kind") {
        auto kind = d.kind(name);
        if (kind == history::Kind::Missing) return env.Null();
        return Napi::String::New(env, kind == history::Kind::Directory ? "directory" : kind == history::Kind::Link ? "link" : kind == history::Kind::File ? "file" : "other");
      }
      if (method == "move") { auto moved = d.move(name, other(info, 1), text(info, 2), info.Length() > 3 && info[3].IsBoolean() && info[3].As<Napi::Boolean>().Value()); return Napi::String::New(env, moved == history::Move::Moved ? "moved" : moved == history::Move::Collision ? "collision" : "missing"); }
      if (method == "mkdir") d.mkdir(name);
      else if (method == "link") d.link(name, text(info, 1, false));
      else if (method == "readLink") return Napi::String::New(env, d.readLink(name));
      else if (method == "removeEmpty") d.removeEmpty(name);
      return env.Undefined();
    } catch (const history::Failure& failure) { return error(info.Env(), failure); }
  }
#define METHOD(name) Napi::Value name(const Napi::CallbackInfo& info) { return call(info, #name); }
  METHOD(close) METHOD(entries) METHOD(same) METHOD(sameDevice) METHOD(open) METHOD(kind) METHOD(move) METHOD(mkdir) METHOD(link) METHOD(readLink) METHOD(removeEmpty)
#undef METHOD
  static Napi::Function define(Napi::Env env, Addon* addon) {
    return DefineClass(env, "HistoryDirectory", {
#define OP(name) InstanceMethod(#name, &Capability::name)
      OP(close), OP(entries), OP(same), OP(sameDevice), OP(open), OP(kind), OP(move), OP(mkdir), OP(link), OP(readLink), OP(removeEmpty)
#undef OP
    }, addon);
  }
 private:
  Addon* addon_;
  std::unique_ptr<Directory> directory_;
  std::shared_ptr<Lifetime> lifetime_;
};
Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  auto* addon = new Addon;
  addon->constructor = Napi::Persistent(Capability::define(env, addon));
  napi_add_env_cleanup_hook(env, [](void* pointer) {
    std::unique_ptr<Addon> owner(static_cast<Addon*>(pointer));
    owner->lifetime->close();
    owner->constructor.Reset();
  }, addon);
  exports.Set("openDirectory", Napi::Function::New(env, [addon](const Napi::CallbackInfo& info) -> Napi::Value {
    try {
      if (info.Length() != 2 || !info[1].IsBoolean()) throw history::Failure("root-argument", "EINVAL", 0);
      return Capability::create(info.Env(), Directory::root(text(info, 0, false), info[1].As<Napi::Boolean>().Value()), addon);
    } catch (const history::Failure& failure) { return error(info.Env(), failure); }
  }));
  return exports;
}
}
NODE_API_MODULE(history_filesystem, initialize)
