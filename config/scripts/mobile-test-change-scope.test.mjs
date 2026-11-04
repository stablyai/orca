import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { shouldRunMobileTests } from './mobile-test-change-scope.mjs'

it('retains tests on missing evidence and a move out of the source tree', () => {
  expect(shouldRunMobileTests([])).toBe(true)
  expect(shouldRunMobileTests(['mobile/src/deleted.ts', 'mobile/docs/moved.ts'])).toBe(true)
})

it('retains unknown suite paths and noncanonical traversal evidence', () => {
  expect(shouldRunMobileTests(['unknown/module.test.ts'])).toBe(true)
  expect(shouldRunMobileTests(['src/unknown/module.test.ts'])).toBe(true)
  expect(shouldRunMobileTests(['src/shared/../main/module.test.ts'])).toBe(true)
})

const workflow = parse(
  readFileSync(resolve(import.meta.dirname, '../../.github/workflows/mobile.yml'), 'utf8')
)

// GitHub path filters: the last pattern a path matches decides, so a negation can be re-included.
function scheduledBy(patterns, file) {
  let scheduled = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const body = (negated ? pattern.slice(1) : pattern)
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replaceAll('**', '\u0000')
      .replaceAll('*', '[^/]*')
      .replaceAll('\u0000', '.*')
    if (new RegExp(`^${body}$`).test(file)) {
      scheduled = !negated
    }
  }
  return scheduled
}

it.each([
  'src/main/codex/structured/prompts/codex-mcp-elicitation.ts',
  'src/renderer/src/components/native-chat/NativeChatApprovalCard.tsx',
  'src/main/native-chat/agent-session-journal/journal-store.ts',
  'src/main/runtime/mobile-desktop-relay/relayed-phone-frames.ts',
  'src/main/codex/codex-settled-body-contract-fixture.ts',
  'src/main/codex/codex-form-transport-envelope.test.ts',
  'src/main/codex/codex-url-opener-contract.test.ts',
  'src/renderer/src/components/native-chat/NativeChatForm.contract.test.tsx',
  'config/tsconfig.test.mobile-host-declarations.json',
  'config/tsconfig.test.pane-launch.json',
  'config/tsconfig.web.json',
  'mobile/tsconfig.test.node.json'
])('schedules the phone/host contract check for %s on PRs and main', (file) => {
  expect(scheduledBy(workflow.on.pull_request.paths, file)).toBe(true)
  expect(scheduledBy(workflow.on.push.paths, file)).toBe(true)
  expect(shouldRunMobileTests([file])).toBe(true)
})

it.each([
  'src/main/codex/structured/prompts/codex-mcp-elicitation.test.ts',
  'src/renderer/src/components/native-chat/NativeChatApprovalCard.test.tsx'
])('leaves other desktop suites to desktop checks: %s', (file) => {
  expect(scheduledBy(workflow.on.pull_request.paths, file)).toBe(false)
  expect(scheduledBy(workflow.on.push.paths, file)).toBe(false)
})
