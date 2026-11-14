#!/usr/bin/env node

const required = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'CSC_LINK',
  'CSC_KEY_PASSWORD'
]

const missing = required.filter((key) => {
  const value = process.env[key]
  return typeof value !== 'string' || value.trim().length === 0
})

if (missing.length > 0) {
  // Allow local ad-hoc validation but fail production release before unsigned/unnotarized package can appear successful.
  console.error('Missing required macOS release signing environment variables:')
  for (const key of missing) {
    console.error(`- ${key}`)
  }
  console.error('')
  console.error('Use `pnpm build:mac` for local ad-hoc builds, or provide the')
  console.error('Developer ID + notarization credentials before running the')
  console.error('production release build.')
  process.exit(1)
}
