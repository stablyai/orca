#include <node_api.h>
#include <stdlib.h>
#include "keyboard-layout-translate.h"

// Any failed N-API call fails the whole read so a partial snapshot can never be cached.
#define CHECK(call) \
  do {              \
    if ((call) != napi_ok) return false; \
  } while (0)

static CFStringRef inputSourceId(TISInputSourceRef source) {
  return source ? (CFStringRef)TISGetInputSourceProperty(source, kTISPropertyInputSourceID) : NULL;
}

static bool sameInputSourceId(CFStringRef left, CFStringRef right) {
  if (left == NULL || right == NULL) {
    return left == right;
  }
  return CFStringCompare(left, right, 0) == kCFCompareEqualTo;
}

static bool stringOrNull(napi_env env, CFStringRef value, napi_value *result) {
  if (value == NULL) {
    CHECK(napi_get_null(env, result));
    return true;
  }
  CFIndex length = CFStringGetLength(value);
  UniChar *characters = malloc(sizeof(UniChar) * (length > 0 ? length : 1));
  if (characters == NULL) {
    return false;
  }
  CFStringGetCharacters(value, CFRangeMake(0, length), characters);
  napi_status status = napi_create_string_utf16(env, characters, (size_t)length, result);
  free(characters);
  return status == napi_ok;
}

static bool translatedCharacter(
  napi_env env,
  const UCKeyboardLayout *layout,
  UInt16 keyCode,
  UInt32 modifierState,
  UInt32 keyboardType,
  napi_value *result
) {
  UniChar characters[ORCA_KEY_CHARACTER_CAPACITY];
  UniCharCount length = 0;
  if (!orcaTranslateKey(layout, keyCode, modifierState, keyboardType, characters, &length)) {
    CHECK(napi_get_null(env, result));
    return true;
  }
  CHECK(napi_create_string_utf16(env, characters, length, result));
  return true;
}

static bool keyCharactersFor(
  napi_env env,
  TISInputSourceRef layoutSource,
  UInt32 keyboardType,
  napi_value *keyCharacters,
  bool *hasLayoutData
) {
  CHECK(napi_create_object(env, keyCharacters));
  CFDataRef data = layoutSource
    ? (CFDataRef)TISGetInputSourceProperty(layoutSource, kTISPropertyUnicodeKeyLayoutData)
    : NULL;
  const UInt8 *bytes = data ? CFDataGetBytePtr(data) : NULL;
  *hasLayoutData = bytes != NULL;
  if (bytes == NULL) {
    return true;
  }
  const UCKeyboardLayout *layout = (const UCKeyboardLayout *)bytes;
  for (size_t index = 0; index < ORCA_DOM_KEY_CODE_COUNT; index++) {
    const OrcaDomKeyCode entry = ORCA_DOM_KEY_CODES[index];
    napi_value characters;
    napi_value unmodified;
    napi_value shifted;
    CHECK(napi_create_object(env, &characters));
    if (!translatedCharacter(env, layout, entry.keyCode, 0, keyboardType, &unmodified) ||
        !translatedCharacter(
          env, layout, entry.keyCode, ORCA_SHIFT_MODIFIER_STATE, keyboardType, &shifted
        )) {
      return false;
    }
    CHECK(napi_set_named_property(env, characters, "unmodified", unmodified));
    CHECK(napi_set_named_property(env, characters, "shifted", shifted));
    CHECK(napi_set_named_property(env, *keyCharacters, entry.code, characters));
  }
  return true;
}

/** `complete` is false when an id or the layout data was unavailable; such partial reads are served but never cached. */
static bool buildResult(
  napi_env env,
  TISInputSourceRef inputSource,
  TISInputSourceRef layoutSource,
  UInt32 keyboardType,
  napi_value *result
) {
  napi_value keyCharacters;
  napi_value snapshot;
  napi_value inputSourceValue;
  napi_value layoutSourceValue;
  napi_value type;
  napi_value complete;
  bool hasLayoutData = false;
  if (!keyCharactersFor(env, layoutSource, keyboardType, &keyCharacters, &hasLayoutData) ||
      !stringOrNull(env, inputSourceId(inputSource), &inputSourceValue) ||
      !stringOrNull(env, inputSourceId(layoutSource), &layoutSourceValue)) {
    return false;
  }
  bool isComplete = hasLayoutData && inputSourceId(inputSource) && inputSourceId(layoutSource);
  CHECK(napi_create_object(env, &snapshot));
  CHECK(napi_set_named_property(env, snapshot, "inputSourceId", inputSourceValue));
  CHECK(napi_set_named_property(env, snapshot, "layoutSourceId", layoutSourceValue));
  CHECK(napi_set_named_property(env, snapshot, "keyCharacters", keyCharacters));
  CHECK(napi_create_uint32(env, keyboardType, &type));
  CHECK(napi_get_boolean(env, isComplete, &complete));
  CHECK(napi_create_object(env, result));
  CHECK(napi_set_named_property(env, *result, "snapshot", snapshot));
  CHECK(napi_set_named_property(env, *result, "keyboardType", type));
  CHECK(napi_set_named_property(env, *result, "complete", complete));
  return true;
}

typedef enum { READ_OK, READ_CHANGED, READ_UNAVAILABLE, READ_ERROR } ReadOutcome;

/** One consistent read; READ_CHANGED when the source or keyboard type moved while translating. */
static ReadOutcome readStableSnapshot(napi_env env, napi_value *result) {
  UInt32 keyboardType = LMGetKbdType();
  TISInputSourceRef inputSource = TISCopyCurrentKeyboardInputSource();
  TISInputSourceRef layoutSource = TISCopyCurrentKeyboardLayoutInputSource();
  ReadOutcome outcome = READ_UNAVAILABLE;
  if (inputSource || layoutSource) {
    outcome = buildResult(env, inputSource, layoutSource, keyboardType, result) ? READ_OK : READ_ERROR;
  }
  TISInputSourceRef finalInputSource = TISCopyCurrentKeyboardInputSource();
  TISInputSourceRef finalLayoutSource = TISCopyCurrentKeyboardLayoutInputSource();
  if (outcome == READ_OK &&
      (!sameInputSourceId(inputSourceId(inputSource), inputSourceId(finalInputSource)) ||
       !sameInputSourceId(inputSourceId(layoutSource), inputSourceId(finalLayoutSource)) ||
       keyboardType != LMGetKbdType())) {
    outcome = READ_CHANGED;
  }
  if (inputSource) CFRelease(inputSource);
  if (layoutSource) CFRelease(layoutSource);
  if (finalInputSource) CFRelease(finalInputSource);
  if (finalLayoutSource) CFRelease(finalLayoutSource);
  return outcome;
}

/** A failed N-API status need not leave an exception pending; make sure the caller sees one. */
static napi_value fail(napi_env env, const char *message) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok || !pending) {
    napi_throw_error(env, NULL, message);
  }
  return NULL;
}

static napi_value readSnapshot(napi_env env, napi_callback_info info) {
  napi_value result;
  for (int attempt = 0; attempt < 2; attempt++) {
    ReadOutcome outcome = readStableSnapshot(env, &result);
    if (outcome == READ_OK) {
      return result;
    }
    if (outcome == READ_ERROR) {
      return fail(env, "keyboard layout read failed");
    }
    if (outcome == READ_UNAVAILABLE) {
      break;
    }
  }
  return napi_get_null(env, &result) == napi_ok ? result : fail(env, "keyboard layout read failed");
}

static napi_value readKeyboardType(napi_env env, napi_callback_info info) {
  napi_value result;
  return napi_create_uint32(env, LMGetKbdType(), &result) == napi_ok
    ? result
    : fail(env, "keyboard type read failed");
}

static bool exportFunction(napi_env env, napi_value exports, const char *name, napi_callback callback) {
  napi_value function;
  CHECK(napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function));
  CHECK(napi_set_named_property(env, exports, name, function));
  return true;
}

static napi_value initialize(napi_env env, napi_value exports) {
  // An incomplete module must fail to load; main retries the load on a later request.
  if (!exportFunction(env, exports, "read", readSnapshot) ||
      !exportFunction(env, exports, "keyboardType", readKeyboardType)) {
    return fail(env, "keyboard layout reader failed to initialize");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
