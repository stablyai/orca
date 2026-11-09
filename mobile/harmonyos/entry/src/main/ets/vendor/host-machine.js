var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// orca-host-machine-entry.ts
var orca_host_machine_entry_exports = {};
__export(orca_host_machine_entry_exports, {
  formatHostMachineLine: () => formatHostMachineLine,
  readMobileRuntimeHostPlatform: () => readMobileRuntimeHostPlatform
});
module.exports = __toCommonJS(orca_host_machine_entry_exports);

// src/shared/host-platform-label.ts
var PLATFORM_LABELS = {
  aix: "AIX",
  android: "Android",
  cygwin: "Cygwin",
  darwin: "macOS",
  freebsd: "FreeBSD",
  haiku: "Haiku",
  linux: "Linux",
  netbsd: "NetBSD",
  openbsd: "OpenBSD",
  sunos: "Solaris",
  win32: "Windows"
};
function hostPlatformDisplayName(platform) {
  return platform ? PLATFORM_LABELS[platform] : null;
}

// src/shared/host-machine-line.ts
var KIND_LABELS = {
  laptop: "Laptop",
  desktop: "Desktop",
  server: "Server"
};
function formatHostMachineLine(machine, platform) {
  const machineLabel = machine ? machine.model?.trim() || KIND_LABELS[machine.kind] : null;
  return [machineLabel, hostPlatformDisplayName(platform)].filter(Boolean).join(" \xB7 ") || null;
}

// src/shared/zod-salvage.ts
function hostUnionArms(coverage) {
  return Object.keys(coverage);
}

// mobile/src/transport/connection/mobile-runtime-host-platform.ts
var NODE_PLATFORM_NAMES = hostUnionArms({
  aix: true,
  android: true,
  darwin: true,
  freebsd: true,
  haiku: true,
  linux: true,
  openbsd: true,
  sunos: true,
  win32: true,
  cygwin: true,
  netbsd: true
});
var NODE_PLATFORMS = new Set(NODE_PLATFORM_NAMES);
function readMobileRuntimeHostPlatform(statusResult) {
  const hostPlatform = statusResult?.hostPlatform;
  return typeof hostPlatform === "string" && NODE_PLATFORMS.has(hostPlatform) ? hostPlatform : null;
}
