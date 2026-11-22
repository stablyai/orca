import type { AndroidSymbol, SFSymbol } from 'expo-symbols'

// Names come from NATIVE_ICON_SYMBOLS and page-header-symbols, both checked against each platform's catalog by hand.

export function sfSymbol(name: string): SFSymbol {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a name the catalog lacks draws nothing; it cannot crash.
  return name as SFSymbol
}

export function materialSymbol(name: string): AndroidSymbol {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a name the font lacks draws nothing; it cannot crash.
  return name as AndroidSymbol
}
