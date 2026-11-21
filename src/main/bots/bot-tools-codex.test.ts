import { expect, it } from 'vitest'
import { codexToolProblems } from './bot-tools-codex'

it("reads app-server's status as a sign-in or a failure, and a working tool as nothing", () => {
  const answer = {
    data: [
      { name: 'notion', runtimeStatus: 'authenticationRequired', toolsError: 'not logged in' },
      { name: 'time', runtimeStatus: 'failed', toolsError: 'spawn uvx ENOENT' },
      { name: 'ok', runtimeStatus: 'connected', toolsError: null },
      { name: 'starting', runtimeStatus: 'connecting' },
      { name: 'owner', runtimeStatus: 'failed' }
    ]
  }
  expect(
    Object.fromEntries(codexToolProblems(answer, ['notion', 'time', 'ok', 'starting', 'missing']))
  ).toEqual({
    notion: { kind: 'sign-in' },
    time: { kind: 'failed', detail: 'spawn uvx ENOENT' },
    starting: { kind: 'unconfirmed' },
    missing: { kind: 'unconfirmed' }
  })
  expect(Object.fromEntries(codexToolProblems({ malformed: true }, ['docs']))).toEqual({
    docs: { kind: 'unconfirmed' }
  })
})
