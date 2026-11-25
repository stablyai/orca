// Release-line floors the launch gate checks and Orca's own copies must reach; kept apart so both can import them.

// Verified release lines: 1.18.31 recordings and 2.0.14 private-child startup.
export const OPENCODE_MINIMUM_VERSIONS = ['1.18.31', '2.0.14'] as const

export const OPENCODE2_MINIMUM_VERSIONS = ['2.0.14'] as const

// The build hash parses as a semver prerelease, so this is the day before the first verified ACP build.
export const CURSOR_MINIMUM_VERSIONS = ['2026.10.21'] as const
