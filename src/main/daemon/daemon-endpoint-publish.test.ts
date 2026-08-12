import type * as NodeFs from 'node:fs'
import {
  linkSync,
  unlinkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDaemonSocketBindPath,
  publishDaemonEndpoint,
  readDaemonSocketIdentity
} from './daemon-endpoint-ownership'
import { probeSocketConnect } from './daemon-endpoint-probe'

const unixIt = it.skipIf(process.platform === 'win32')

type Listener = { server: Server; connections: () => number }

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-p-'))
}

async function listen(socketPath: string): Promise<Listener> {
  let connectionCount = 0
  const server = createServer((socket) => {
    connectionCount += 1
    socket.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { server, connections: () => connectionCount }
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function expectReachable(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
    socket.once('error', reject)
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function publishListener(boundPath: string, canonicalPath: string): Promise<void> {
  const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)
  expect(outcome.status).toBe('published')
}

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

describe('publishDaemonEndpoint', () => {
  unixIt('publishes a listener when the canonical endpoint is free', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('leaves a live incumbent in place', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probeSocketConnect)

      expect(outcome).toEqual({ status: 'occupied' })
      await expectReachable(canonicalPath)
      expect(incumbent.connections()).toBe(2)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('replaces an incumbent that has stopped listening', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      await close(incumbent.server)

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt(
    'never replaces a daemon that published while the death proof was being gathered',
    async () => {
      // Why: the proof describes the entry that was probed, not whatever holds the name by the
      // time we act on it. A publisher stalled between the two would otherwise destroy an
      // established daemon it never proved dead — the original bug, reached by a narrow window.
      const directory = makeTempDir()
      const canonicalPath = join(directory, 'd')
      const stalePath = getDaemonSocketBindPath(canonicalPath)
      const winnerPath = getDaemonSocketBindPath(canonicalPath)
      const latecomerPath = getDaemonSocketBindPath(canonicalPath)
      const stale = await listen(stalePath)
      const winner = await listen(winnerPath)
      const latecomer = await listen(latecomerPath)
      try {
        // A dead entry both publishers will legitimately prove dead.
        await publishListener(stalePath, canonicalPath)
        await close(stale.server)

        // The winner takes the name while the latecomer is still probing the dead entry. Only on
        // the first probe: the retry must see a live incumbent, which is the point.
        const winnerIdentity = readDaemonSocketIdentity(winnerPath)
        let raced = false
        const probe = async (path: string) => {
          const outcome = await probeSocketConnect(path)
          if (!raced) {
            raced = true
            renameSync(winnerPath, canonicalPath)
          }
          return outcome
        }
        const outcome = await publishDaemonEndpoint(latecomerPath, canonicalPath, probe)

        // The latecomer must back off, and the winner must still own a reachable endpoint.
        // Two connections to the winner: the latecomer's retry probe, then expectReachable.
        expect(outcome).toEqual({ status: 'occupied' })
        await expectReachable(canonicalPath)
        expect(winner.connections()).toBe(2)
        expect(latecomer.connections()).toBe(0)
        expect(readDaemonSocketIdentity(canonicalPath)).toEqual(winnerIdentity)
      } finally {
        await Promise.all([close(stale.server), close(winner.server), close(latecomer.server)])
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  unixIt('leaves an incumbent untouched when probing is inconclusive', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      const before = statSync(canonicalPath, { bigint: true })
      const probe = vi.fn(async () => 'unknown' as const)

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probe)

      const after = statSync(canonicalPath, { bigint: true })
      expect(outcome).toEqual({ status: 'inconclusive' })
      expect(probe).toHaveBeenCalledWith(canonicalPath)
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
      await expectReachable(canonicalPath)
      expect(incumbent.connections()).toBe(1)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('replaces a regular file occupying the endpoint', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      writeFileSync(canonicalPath, 'stale')

      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('replaces a dangling symlink occupying the endpoint', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      symlinkSync(join(directory, 'x'), canonicalPath)

      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('treats a probe that throws as inconclusive rather than as proof of death', async () => {
    // Why: a probe that failed classified nothing. Letting a thrown error fall through to the
    // dead branch would replace an endpoint that may well be serving.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      const before = readDaemonSocketIdentity(canonicalPath)
      const probe = vi.fn(async () => {
        throw new Error('probe blew up')
      })

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probe)

      expect(outcome).toEqual({ status: 'inconclusive' })
      expect(readDaemonSocketIdentity(canonicalPath)).toEqual(before)
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('still publishes on a filesystem that refuses hard links', async () => {
    // Why: some POSIX and FUSE filesystems accept a bound Unix socket and rename but reject
    // hard links. Requiring the link would mean no daemon persistence at all there, which is a
    // capability the previous implementation had. Replacing is safe here only because the
    // post-publish verification exists to catch a loser — it did not when this was first removed.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          linkSync: () => {
            throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' })
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithoutLinks } =
        await import('./daemon-endpoint-ownership')

      const outcome = await publishWithoutLinks(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('does not fall back to replacing when a link fails for another reason', async () => {
    // Why: only "this filesystem cannot do hard links" licenses giving up link's exclusivity.
    // An ENOSPC or EIO must surface, not silently downgrade to a replace.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          linkSync: () => {
            throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithBrokenLink } =
        await import('./daemon-endpoint-ownership')

      await expect(
        publishWithBrokenLink(boundPath, canonicalPath, probeSocketConnect)
      ).rejects.toMatchObject({ code: 'EIO' })
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('will not replace an occupied entry whose continuity it could not read', async () => {
    // Why: every stat failure collapses to null, so two unreadable reads bracketing a positive
    // death probe would otherwise compare equal and authorise a rename with no evidence the
    // entry is still the one proven dead. The probe is injected here so the only entry reads
    // are the continuity ones, which makes the failure unambiguous.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const deadBind = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const dead = await listen(deadBind)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(deadBind, canonicalPath)
      await close(dead.server)
      const occupant = statSync(canonicalPath, { bigint: true })

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          lstatSync: (target: string, options?: { bigint?: boolean }) => {
            if (target === canonicalPath) {
              throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
            }
            return actual.lstatSync(target, options as never)
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishBlind } = await import('./daemon-endpoint-ownership')

      const outcome = await publishBlind(newcomerPath, canonicalPath, async () => 'refused')

      expect(outcome).toEqual({ status: 'inconclusive' })
      const after = statSync(canonicalPath, { bigint: true })
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: occupant.dev, ino: occupant.ino })
    } finally {
      await Promise.all([close(dead.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('records an identity the ownership watchdog can still match afterwards', async () => {
    // Why this matters and why no ordinary test catches it: the recorded identity is what the
    // watchdog later compares the entry against, and that comparison includes birthtimeMs. Node
    // documents birthtimeMs as sometimes holding the ctime instead — libuv fills it from st_ctim
    // on Linux kernels without statx. link and rename both bump ctime, so an identity read
    // BEFORE publishing could never match the entry again on such a host: the daemon would
    // declare itself lost on its first session and stand down permanently. Simulated here by
    // reporting ctime as birthtime, which is exactly what those platforms do.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        // What a host whose birth time is really the ctime reports.
        const asCtimeBirthtime = (stats: { ctimeMs: number; ctimeNs?: bigint }) => ({
          ...stats,
          birthtimeMs: stats.ctimeMs,
          ...(stats.ctimeNs === undefined ? {} : { birthtimeNs: stats.ctimeNs })
        })
        return {
          ...actual,
          statSync: (target: string, options?: { bigint?: boolean }) =>
            asCtimeBirthtime(actual.statSync(target, options as never) as never),
          lstatSync: (target: string, options?: { bigint?: boolean }) =>
            asCtimeBirthtime(actual.lstatSync(target, options as never) as never)
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishOnCtimeFs, readDaemonEndpointOwnershipState } =
        await import('./daemon-endpoint-ownership')

      const outcome = await publishOnCtimeFs(boundPath, canonicalPath, probeSocketConnect)
      expect(outcome).toMatchObject({ status: 'published' })

      // The watchdog must still recognise the endpoint as ours.
      const owned = (outcome as { identity: unknown }).identity
      expect(readDaemonEndpointOwnershipState(canonicalPath, owned as never)).toBe('owned')
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('will not rename over a live daemon indistinguishable by directory entry', async () => {
    // The case the re-probe exists for: the entry proved dead is unlinked and its inode number
    // handed straight back to a replacement, so the continuity check sees the same dev+ino and
    // cannot tell them apart. Birth time was meant to separate them and cannot be relied on —
    // it may be the ctime, the epoch, or coarser than the events it must separate. Recycling
    // cannot be provoked on demand, so identity is pinned to a constant here, which is exactly
    // what a recycled inode number looks like to this code.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const deadBind = getDaemonSocketBindPath(canonicalPath)
    const livePath = getDaemonSocketBindPath(canonicalPath)
    const latecomerPath = getDaemonSocketBindPath(canonicalPath)
    const dead = await listen(deadBind)
    const live = await listen(livePath)
    const latecomer = await listen(latecomerPath)
    try {
      await publishListener(deadBind, canonicalPath)
      await close(dead.server)
      const frozen = statSync(canonicalPath, { bigint: true })

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          lstatSync: (target: string, options?: { bigint?: boolean }) =>
            target === canonicalPath ? frozen : actual.lstatSync(target, options as never)
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishAgainstRecycled } =
        await import('./daemon-endpoint-ownership')

      let swapped = false
      const probe = async (path: string) => {
        const outcome = await probeSocketConnect(path)
        if (!swapped) {
          swapped = true
          unlinkSync(canonicalPath)
          linkSync(livePath, canonicalPath)
        }
        return outcome
      }

      const outcome = await publishAgainstRecycled(latecomerPath, canonicalPath, probe)

      // Identity says unchanged; something is serving, so it must not be replaced.
      expect(outcome).toEqual({ status: 'occupied' })
      await expectReachable(canonicalPath)
      expect(latecomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(dead.server), close(live.server), close(latecomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('declines rather than claims an owner when the second probe proves nothing', async () => {
    // Why: the probe taken immediately before replacing has exactly the authority of the first
    // one. A timeout or an EPERM there proves no live incumbent, and reporting 'occupied' would
    // send the launcher off to adopt a daemon that may not exist.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const deadBind = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const dead = await listen(deadBind)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(deadBind, canonicalPath)
      await close(dead.server)
      const deadEntry = readDaemonSocketIdentity(canonicalPath)

      // Dead on the first ask, unclassifiable on the second.
      let asked = 0
      const probe = async () => {
        asked += 1
        return asked === 1 ? ('refused' as const) : ('unknown' as const)
      }

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probe)

      expect(outcome).toEqual({ status: 'inconclusive' })
      expect(readDaemonSocketIdentity(canonicalPath)).toEqual(deadEntry)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(dead.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('declines on an unclassifiable first probe even if the second proves death', async () => {
    // Why pinned: the second probe re-establishes death immediately before the rename, so the
    // first probe's guard is no longer what makes replacing safe — it is what keeps the protocol
    // conservative. Without it an endpoint that could not be classified at all would still be
    // replaced, on the strength of one later reading. Declining on any doubt is the contract.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const deadBind = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const dead = await listen(deadBind)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(deadBind, canonicalPath)
      await close(dead.server)
      const deadEntry = readDaemonSocketIdentity(canonicalPath)

      // Unclassifiable first, decisively dead second.
      let asked = 0
      const probe = async () => {
        asked += 1
        return asked === 1 ? ('unknown' as const) : ('refused' as const)
      }

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probe)

      expect(outcome).toEqual({ status: 'inconclusive' })
      expect(readDaemonSocketIdentity(canonicalPath)).toEqual(deadEntry)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(dead.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('refuses to serve a bound endpoint it cannot identify', async () => {
    // Why: without the bound identity we can neither verify the publish nor arm the ownership
    // watchdog, so we would serve a name we could never check. Startup has nothing to protect.
    const directory = makeTempDir()
    try {
      await expect(
        publishDaemonEndpoint(
          join(directory, '.bmissing'),
          join(directory, 'd'),
          probeSocketConnect
        )
      ).rejects.toThrow(/Cannot identify the bound daemon endpoint/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('reports lost when the name it took disappears before verification', async () => {
    // Why not 'published': the entry we took is gone, so nothing resolves to this listener.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          unlinkSync: (target: string) => {
            actual.unlinkSync(target)
            if (target === boundPath) {
              actual.unlinkSync(canonicalPath)
            }
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithRemover } =
        await import('./daemon-endpoint-ownership')

      await expect(
        publishWithRemover(boundPath, canonicalPath, probeSocketConnect)
      ).resolves.toEqual({ status: 'lost' })
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('declines rather than publishes when the endpoint cannot be verified', async () => {
    // Why fail closed: an unreadable canonical entry is not evidence we are reachable, and a
    // starting daemon loses nothing by declining.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      // Why inject the failure directly rather than dropping directory permissions: a
      // permission-based setup induces nothing when the suite runs as root, and the test would
      // then pass without ever reaching the branch it names.
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        let published = false
        return {
          ...actual,
          unlinkSync: (target: string) => {
            actual.unlinkSync(target)
            if (target === boundPath) {
              published = true
            }
          },
          statSync: (target: string, options?: { bigint?: boolean }) => {
            if (published && target === canonicalPath) {
              throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' })
            }
            return actual.statSync(target, options as never)
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithBlockedStat } =
        await import('./daemon-endpoint-ownership')

      await expect(
        publishWithBlockedStat(boundPath, canonicalPath, probeSocketConnect)
      ).resolves.toEqual({ status: 'inconclusive' })
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('reports lost when another listener replaces it before verification', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const competitorPath = getDaemonSocketBindPath(canonicalPath)
    const competitorLink = join(directory, '.r')
    const newcomer = await listen(boundPath)
    const competitor = await listen(competitorPath)
    try {
      writeFileSync(canonicalPath, 'stale')
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          renameSync: (source: string, destination: string) => {
            actual.renameSync(source, destination)
            if (source === boundPath && destination === canonicalPath) {
              actual.renameSync(competitorLink, canonicalPath)
            }
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithRacer } =
        await import('./daemon-endpoint-ownership')
      // Why the competitor only takes the name from inside our own rename: publishing during
      // the probe is caught earlier now, by the pre-rename evidence check. 'lost' is
      // specifically the window between taking the name and verifying we still hold it.
      // Idempotent: the protocol probes again immediately before replacing, so this runs twice.
      let linked = false
      const probe = async () => {
        if (!linked) {
          linked = true
          linkSync(competitorPath, competitorLink)
        }
        return 'refused' as const
      }

      const outcome = await publishWithRacer(boundPath, canonicalPath, probe)

      expect(outcome).toEqual({ status: 'lost' })
      await expectReachable(canonicalPath)
      expect(competitor.connections()).toBe(1)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(newcomer.server), close(competitor.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('propagates link errors other than EEXIST', async () => {
    const directory = makeTempDir()
    const boundPath = join(directory, '.b')
    const canonicalPath = join(directory, 'x', 'd')
    const newcomer = await listen(boundPath)
    try {
      const probe = vi.fn(async () => 'missing' as const)

      await expect(publishDaemonEndpoint(boundPath, canonicalPath, probe)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('leaves the published endpoint behind when its own owner closes', async () => {
    // Why this and not a "late close" staging: closing is what makes an incumbent replaceable,
    // so the two cannot be ordered against each other at this level. The property that made the
    // original bug possible is testable directly — libuv unlinks the pathname a server BOUND
    // to, so a daemon that published by linking a private name must leave the canonical entry
    // intact when it closes. Ordering a close after a replacement publishes needs the full
    // lifecycle and is covered in daemon-endpoint-ownership.test.ts.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const replacementPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const replacement = await listen(replacementPath)
    try {
      const published = await publishDaemonEndpoint(
        incumbentPath,
        canonicalPath,
        probeSocketConnect
      )
      expect(published).toMatchObject({ status: 'published' })

      await close(incumbent.server)

      // The entry survives its owner's close — dead, but still the name to be replaced.
      expect(readDaemonSocketIdentity(canonicalPath)).not.toBeNull()
      await expect(probeSocketConnect(canonicalPath)).resolves.toBe('refused')

      const outcome = await publishDaemonEndpoint(
        replacementPath,
        canonicalPath,
        probeSocketConnect
      )
      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(replacement.connections()).toBe(1)
    } finally {
      await Promise.all([close(incumbent.server), close(replacement.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('returns the identity that actually holds the canonical name', async () => {
    // Why: callers arm the ownership watchdog with this value, so an identity that does not
    // describe the published entry makes every later ownership check meaningless.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome.status).toBe('published')
      expect(outcome.status === 'published' ? outcome.identity : null).toEqual(
        readDaemonSocketIdentity(canonicalPath)
      )
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
