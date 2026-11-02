/** Registry root handles. Orca reads HKCU and HKLM; the rest are here to keep the enum faithful. */
export declare const HK: {
  readonly CR: 0x80000000
  readonly CU: 0x80000001
  readonly LM: 0x80000002
  readonly U: 0x80000003
  readonly PD: 0x80000004
  readonly CC: 0x80000005
  readonly DD: 0x80000006
}

export type RegistryValue = {
  name: string
  type: number
  value?: string | number | number[] | string[]
}

/** Every value under `path`, keyed by value name. Null when the key cannot be opened or read. */
export declare function getRegistryKey(
  root: number,
  path: string
): Record<string, RegistryValue> | null
