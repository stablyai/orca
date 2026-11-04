#pragma once

#include <napi.h>

Napi::Value SpawnDetachedIsolated(const Napi::CallbackInfo& info);
Napi::Value IsolatedSpawnBreaksAwayFromJob(const Napi::CallbackInfo& info);
