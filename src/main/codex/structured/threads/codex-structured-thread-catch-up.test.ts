import { describe } from 'vitest'
import { registerCodexHistoryBoundsTests } from './codex-structured-thread-catch-up-bounds.spec'

import {
  SESSION,
  THREAD,
  chat,
  turn,
  codexWith
} from './codex-thread-catch-up-contract-test-fixture'
describe('Codex chat catch-up', () => {
  registerCodexHistoryBoundsTests({ chat, turn, codexWith, sessionId: SESSION, threadId: THREAD })
})
