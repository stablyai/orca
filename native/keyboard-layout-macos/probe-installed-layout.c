// Test probe: translates one key of an installed, unselected layout through the shipped translation.
#include <stdio.h>
#include "keyboard-layout-translate.h"

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  CFStringRef id = CFStringCreateWithCString(NULL, argv[1], kCFStringEncodingUTF8);
  const void *keys[] = {kTISPropertyInputSourceID};
  const void *values[] = {id};
  CFDictionaryRef filter = CFDictionaryCreate(
    NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks
  );
  CFArrayRef sources = TISCreateInputSourceList(filter, true);
  if (sources == NULL || CFArrayGetCount(sources) == 0) return 3;
  TISInputSourceRef source = (TISInputSourceRef)CFArrayGetValueAtIndex(sources, 0);
  CFDataRef data = (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
  if (data == NULL) return 4;
  for (size_t index = 0; index < ORCA_DOM_KEY_CODE_COUNT; index++) {
    if (strcmp(ORCA_DOM_KEY_CODES[index].code, argv[2]) != 0) continue;
    UniChar characters[ORCA_KEY_CHARACTER_CAPACITY];
    UniCharCount length = 0;
    orcaTranslateKey(
      (const UCKeyboardLayout *)CFDataGetBytePtr(data),
      ORCA_DOM_KEY_CODES[index].keyCode,
      0,
      LMGetKbdType(),
      characters,
      &length
    );
    for (UniCharCount unit = 0; unit < length; unit++) printf("%04X", characters[unit]);
    return 0;
  }
  return 5;
}
