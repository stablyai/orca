import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativeRoute = readFileSync(
  new URL('../../app/h/[hostId]/source-control/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const hostedRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/source-control/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const presentation = readFileSync(
  new URL('./MobileSourceControlPanel.tsx', import.meta.url),
  'utf8'
)
const runners = readFileSync(
  new URL('./use-mobile-source-control-runners.ts', import.meta.url),
  'utf8'
)
const openers = readFileSync(
  new URL('./use-mobile-source-control-openers.ts', import.meta.url),
  'utf8'
)

describe('mobile web source control screen binding', () => {
  it('mounts the existing panel with a bounded hosted client', () => {
    expect(nativeRoute).toContain('export function MobileSourceControlRoute(')
    expect(nativeRoute).toContain('<MobileSourceControlPanel')
    expect(hostedRoute).toContain(
      "import { MobileSourceControlRoute } from '../../../../app/h/[hostId]/source-control/[worktreeId]'"
    )
    expect(hostedRoute).toContain('webHostSourceControlClient(shell.client, workspaceId)')
    expect(hostedRoute).not.toContain('routeOrigin=')
    expect(hostedRoute).toContain('binding={{')
    expect(hostedRoute).toContain('shell.client?.native.hapticSelection()')
    expect(hostedRoute).toContain("shell.client?.native.hapticFeedback('success')")
    expect(hostedRoute).toContain('shell.client?.native.clipboardWrite(text)')
    expect(hostedRoute).toContain('shell.client?.native.openExternal(url)')
    expect(hostedRoute).not.toMatch(/StyleSheet|<View|<Text|<Pressable|<div/)
    expect(presentation).toContain('binding?: HostSourceControlBinding')
    expect(presentation).toContain('shellOperations={prShellOperations}')
    expect(runners).not.toContain("from '../platform/haptics'")
    expect(openers).not.toContain("from '../platform/haptics'")
  })
})
