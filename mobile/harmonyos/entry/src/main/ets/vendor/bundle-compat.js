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

// orca-bundle-compat-entry.ts
var orca_bundle_compat_entry_exports = {};
__export(orca_bundle_compat_entry_exports, {
  MOBILE_WEB_PAGE_VERSION_FLOOR: () => MOBILE_WEB_PAGE_VERSION_FLOOR,
  MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS: () => MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS,
  SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS: () => SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS,
  evaluateCompat: () => evaluateCompat,
  evaluateMobileWebBundleCompat: () => evaluateMobileWebBundleCompat
});
module.exports = __toCommonJS(orca_bundle_compat_entry_exports);

// mobile/src/transport/connection/protocol-version.ts
var MOBILE_PROTOCOL_VERSION = 3;
var MIN_COMPATIBLE_DESKTOP_VERSION = 2;

// mobile/src/transport/connection/protocol-compat.ts
function evaluateCompat(input) {
  const desktopVersion = input.desktopProtocolVersion ?? 0;
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0;
  if (MOBILE_PROTOCOL_VERSION < requiredMobile) {
    return {
      kind: "blocked",
      reason: "mobile-too-old",
      desktopVersion,
      requiredMobileVersion: requiredMobile
    };
  }
  if (desktopVersion < MIN_COMPATIBLE_DESKTOP_VERSION) {
    return {
      kind: "blocked",
      reason: "desktop-too-old",
      desktopVersion,
      requiredDesktopVersion: MIN_COMPATIBLE_DESKTOP_VERSION
    };
  }
  return { kind: "ok" };
}

// src/shared/mobile-web-bundle/mobile-web-bundle-capability.ts
var MOBILE_WEB_BUNDLE_CAPABILITY = "mobileWeb.bundle.v1";

// mobile/src/transport/web-bundle/mobile-web-bundle-compat.ts
var MOBILE_WEB_PAGE_VERSION_FLOOR = 1;
var MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS = 3;
var SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS = [1];
function knowsSchemaVersion(schemaVersion) {
  return SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS.some(
    (supported) => supported === schemaVersion
  );
}
function evaluateMobileWebBundleCompat(input) {
  if (!input.hostCapabilities.includes(MOBILE_WEB_BUNDLE_CAPABILITY)) {
    return { kind: "blocked", reason: "bundle-unavailable" };
  }
  const { manifest } = input;
  if (manifest === null) {
    return { kind: "ok", manifestChecked: false };
  }
  if (!knowsSchemaVersion(manifest.schemaVersion)) {
    return {
      kind: "blocked",
      reason: "bundle-shell-too-old",
      schemaVersion: manifest.schemaVersion
    };
  }
  const pageVersion = manifest.pageVersion ?? 0;
  if (pageVersion < MOBILE_WEB_PAGE_VERSION_FLOOR) {
    return {
      kind: "blocked",
      reason: "bundle-incompatible",
      side: "desktop",
      pageVersion,
      requiredPageVersion: MOBILE_WEB_PAGE_VERSION_FLOOR
    };
  }
  const hostProtocolVersion = input.hostStatus.protocolVersion ?? 0;
  if (hostProtocolVersion < manifest.minCompatibleRuntimeProtocolVersion) {
    return {
      kind: "blocked",
      reason: "bundle-incompatible",
      side: "desktop",
      hostProtocolVersion,
      requiredHostProtocolVersion: manifest.minCompatibleRuntimeProtocolVersion
    };
  }
  const requiredBundleRuntimeProtocolVersion = input.hostStatus.minCompatibleMobileVersion ?? 0;
  if (manifest.runtimeProtocolVersion < requiredBundleRuntimeProtocolVersion) {
    return {
      kind: "blocked",
      reason: "bundle-incompatible",
      side: "mobile",
      bundleRuntimeProtocolVersion: manifest.runtimeProtocolVersion,
      requiredBundleRuntimeProtocolVersion
    };
  }
  return { kind: "ok", manifestChecked: true };
}
