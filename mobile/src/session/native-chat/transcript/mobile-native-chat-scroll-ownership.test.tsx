// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'

it("forgets a closed tool line's nested command and output positions, not its neighbours'", () => {
  const at = { top: 30, followsEnd: false }
  const memory = new Map(
    ['run:o', 'run:o/line:a:command', 'run:o/line:a:output', 'line:a:command']
      .concat(['run:o/line:ab:command', 'diff:src/line:a.ts'])
      .map((address) => [address, at] as const)
  )
  new MobileNativeChatScrollRoots(memory, 10).forget('line:a')
  expect([...memory.keys()]).toEqual(['run:o', 'run:o/line:ab:command', 'diff:src/line:a.ts'])
})
