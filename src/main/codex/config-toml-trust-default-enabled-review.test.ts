import { expect, it } from 'vitest'
import { moveHookTrustEntriesInContent, readHookTrustEntriesFromContent } from './config-toml-trust'

it('does not inherit a stale destination disablement when the source has no explicit enabled flag', () => {
  const source = '/home/dev/.codex/hooks.json:stop:0:0'
  const target = '/home/dev/.codex/hooks.json:stop:1:0'
  const input = `[hooks.state."${source}"]\ntrusted_hash = "sha256:source"\n\n[hooks.state."${target}"]\nenabled = false\ntrusted_hash = "sha256:stale-destination"\n`
  const output = readHookTrustEntriesFromContent(
    moveHookTrustEntriesInContent(input, [{ fromKey: source, toKey: target }])
  )
  expect(output.get(target)?.trustedHash).toBe('sha256:source')
  expect(output.get(target)?.enabled).not.toBe(false)
})

it('does not inherit a stale destination approval when the source is unapproved', () => {
  const source = '/home/dev/.codex/hooks.json:stop:0:0'
  const target = '/home/dev/.codex/hooks.json:stop:1:0'
  const input = `[hooks.state."${target}"]\nenabled = true\ntrusted_hash = "sha256:old-approval-for-same-command"\n`
  const output = readHookTrustEntriesFromContent(
    moveHookTrustEntriesInContent(input, [{ fromKey: source, toKey: target }])
  )
  expect(output.get(target)?.trustedHash).toBeUndefined()
})
