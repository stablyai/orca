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

  unixIt(
    'never replaces a daemon that published while the death proof was being gathered',
    async () => {
      const directory = makeTempDir()
      const canonicalPath = join(directory, 'd')
      const stalePath = getDaemonSocketBindPath(canonicalPath)
      const winnerPath = getDaemonSocketBindPath(canonicalPath)
      const latecomerPath = getDaemonSocketBindPath(canonicalPath)
      const stale = await listen(stalePath)
      const winner = await listen(winnerPath)
      const latecomer = await listen(latecomerPath)
      try {
        await publishListener(stalePath, canonicalPath)
        await close(stale.server)

        // Replace only during the first probe so the retry observes the live winner.
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

        // The winner receives the retry probe and expectReachable connection.
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
    // Simulate filesystems that support socket rename but reject hard links.
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
    // Inject the probe so only continuity reads fail; two unreadable stats cannot prove an unchanged entry.
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
    // Simulate birthtime aliasing ctime: publication must not turn timestamp changes into ownership loss.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
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

      const owned = (outcome as { identity: unknown }).identity
      expect(readDaemonEndpointOwnershipState(canonicalPath, owned as never)).toBe('owned')
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('will not rename over a live daemon indistinguishable by directory entry', async () => {
    // Freeze identity to simulate inode reuse, which cannot reliably be forced on demand.
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

      expect(outcome).toEqual({ status: 'occupied' })
      await expectReachable(canonicalPath)
      expect(latecomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(dead.server), close(live.server), close(latecomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('declines rather than claims an owner when the second probe proves nothing', async () => {
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
    // The first inconclusive probe must decline even if a later probe would prove death.
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
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      // Inject EACCES: chmod would not deny reads when tests run as root.
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
      // Replace inside rename to reach the post-publish verification window; probing races are caught earlier.
      // Both probes share this setup, so create the competitor link only once.
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
    // libuv closes the private bound name; the canonical entry must survive for the next publisher.
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
