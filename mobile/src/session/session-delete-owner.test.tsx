import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { useProvenSessionOwner } from './session-delete-owner'

let owner: ExecutionHostId | null = null
function Probe({ entry, observed }: { entry: string; observed: ExecutionHostId | null }) {
  owner = useProvenSessionOwner(entry, observed)
  return null
}

// A bare-id refresh that names a same-id checkout on another host must not qualify it for Delete.
describe('useProvenSessionOwner', () => {
  const run = async (reads: (ExecutionHostId | null)[], entry = 'desk\n\nrepo::/a') => {
    let renderer: ReactTestRenderer | undefined
    for (const observed of reads) {
      await act(async () => {
        if (renderer) {
          renderer.update(<Probe entry={entry} observed={observed} />)
        } else {
          renderer = create(<Probe entry={entry} observed={observed} />)
        }
      })
    }
    return renderer
  }

  it('keeps the first proven owner and refuses once a later read names another', async () => {
    await run([null, 'local'])
    expect(owner).toBe('local')
    // Lookup before tap: A, then B's refresh.
    await run(['local', 'ssh:box'])
    expect(owner).toBeNull()
    // A held older lookup for A landing after B's.
    await run(['ssh:box', 'local', 'ssh:box'])
    expect(owner).toBeNull()
  })

  it('starts over only when the session opens another entry', async () => {
    const renderer = await run(['local', 'ssh:box'])
    await act(async () => renderer?.update(<Probe entry={'desk\n\nrepo::/b'} observed="ssh:box" />))
    expect(owner).toBe('ssh:box')
  })
})
