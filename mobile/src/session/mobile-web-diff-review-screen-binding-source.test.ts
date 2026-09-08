import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativeRoute = readFileSync(
  new URL('../../app/h/[hostId]/review/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const hostedRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/review/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const presentation = readFileSync(
  new URL('../components/MobileDiffReviewScreenView.tsx', import.meta.url),
  'utf8'
)
const interactions = readFileSync(
  new URL('./use-mobile-diff-review-interactions.ts', import.meta.url),
  'utf8'
)
const sendActions = readFileSync(
  new URL('./use-mobile-diff-review-send-actions.ts', import.meta.url),
  'utf8'
)

describe('mobile web diff review screen binding', () => {
  it('mounts the unchanged review presentation through typed hosted operations', () => {
    expect(nativeRoute).toContain('export function MobileDiffReviewRoute(')
    expect(nativeRoute).toContain('<MobileDiffReviewScreenView')
    expect(hostedRoute).toContain(
      "import { MobileDiffReviewRoute } from '../../../../app/h/[hostId]/review/[worktreeId]'"
    )
    expect(hostedRoute).toContain('webHostDiffReviewClient(shell.client, workspaceId)')
    expect(hostedRoute).toContain('shell.client?.native.clipboardWrite(text)')
    expect(hostedRoute).toContain('shell.client?.native.openExternal(url)')
    expect(hostedRoute).not.toMatch(/StyleSheet|<View|<Text|<Pressable|<div/)
    expect(presentation).not.toContain('HostDiffReviewBinding')
    expect(presentation).toContain('shellOperations={controller.device}')
    expect(interactions).not.toContain("from '../platform/haptics'")
    expect(sendActions).not.toContain("from 'expo-clipboard'")
  })
})
