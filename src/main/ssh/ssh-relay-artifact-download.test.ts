import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadSshRelayArtifact } from './ssh-relay-artifact-download'
import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import {
  selectSshRelayArtifact,
  type SshRelaySelectedArtifact
} from './ssh-relay-artifact-selector'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const bytes = Buffer.from('verified relay runtime bytes')
const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const
const temporaryDirectories: string[] = []

function selectedArtifact(): SshRelaySelectedArtifact {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.tuples[0].archive.size = bytes.length
  manifest.tuples[0].archive.sha256 = sha256
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  const verified = verifySshRelayArtifactManifest(manifest, [
    { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
  ])
  const selected = selectSshRelayArtifact(verified, {
    os: 'linux',
    architecture: 'x64',
    processTranslated: false,
    kernelVersion: '6.8',
    libc: { family: 'glibc', version: '2.39' },
    libstdcxxVersion: '6.0.33',
    glibcxxVersion: '3.4.33'
  })
  if (selected.kind !== 'selected') {
    throw new Error('Expected compatible test artifact')
  }
  return selected
}

async function destination(name = 'runtime.partial'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-relay-download-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

function exactResponse(body: BodyInit = bytes): Response {
  return new Response(body, { status: 200, headers: { 'content-length': String(bytes.length) } })
}

afterEach(async () => {
  netFetchMock.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay artifact download', () => {
  it('streams exact signed bytes into an exclusive temporary file', async () => {
    const artifact = selectedArtifact()
    const destinationPath = await destination()
    netFetchMock.mockResolvedValueOnce(exactResponse())

    await expect(downloadSshRelayArtifact({ artifact, destinationPath })).resolves.toEqual({
      destinationPath,
      finalUrl: artifact.archive.downloadUrl,
      size: bytes.length,
      sha256
    })
    expect(await readFile(destinationPath)).toEqual(bytes)
    expect(netFetchMock).toHaveBeenCalledWith(artifact.archive.downloadUrl, {
      credentials: 'omit',
      headers: { Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
  })

  it('follows one approved GitHub asset redirect without forwarding sensitive headers', async () => {
    const artifact = selectedArtifact()
    const destinationPath = await destination()
    const redirectedUrl = 'https://release-assets.githubusercontent.com/example/runtime?sig=secret'
    netFetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: redirectedUrl } })
      )
      .mockResolvedValueOnce(exactResponse())

    await downloadSshRelayArtifact({ artifact, destinationPath })

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(netFetchMock.mock.calls[1]).toEqual([
      redirectedUrl,
      {
        credentials: 'omit',
        headers: { Accept: 'application/octet-stream' },
        redirect: 'manual',
        signal: expect.any(AbortSignal)
      }
    ])
  })

  it.each([
    ['http://release-assets.githubusercontent.com/runtime', /https/i],
    ['https://example.com/runtime', /origin/i],
    ['https://user:secret@release-assets.githubusercontent.com/runtime', /credentials/i],
    ['https://release-assets.githubusercontent.com:444/runtime', /port/i],
    [null, /location/i]
  ])(
    'rejects an unsafe redirect location %s and removes partial output',
    async (location, error) => {
      const destinationPath = await destination()
      netFetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: location ? { location } : undefined })
      )

      await expect(
        downloadSshRelayArtifact({ artifact: selectedArtifact(), destinationPath })
      ).rejects.toThrow(error)
      await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects redirect chains and non-200 responses', async () => {
    for (const responses of [
      [new Response(null, { status: 404 })],
      [new Response(null, { status: 429 })],
      [new Response(null, { status: 503 })],
      [
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/first' }
        }),
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/second' }
        })
      ]
    ]) {
      const destinationPath = await destination()
      netFetchMock.mockReset()
      netFetchMock.mockResolvedValueOnce(responses[0])
      if (responses[1]) {
        netFetchMock.mockResolvedValueOnce(responses[1])
      }

      await expect(
        downloadSshRelayArtifact({ artifact: selectedArtifact(), destinationPath })
      ).rejects.toThrow(/status|redirect/i)
      await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it.each([
    [new Response(null, { status: 200 }), /body/i],
    [new Response(bytes.subarray(1)), /size/i],
    [new Response(Buffer.concat([bytes, bytes])), /size/i],
    [new Response(Buffer.alloc(bytes.length, 1)), /sha-?256/i]
  ])('rejects malformed or unverified response bytes', async (response, error) => {
    const destinationPath = await destination()
    netFetchMock.mockResolvedValueOnce(response)

    await expect(
      downloadSshRelayArtifact({ artifact: selectedArtifact(), destinationPath })
    ).rejects.toThrow(error)
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels a response whose declared length disagrees with the signed manifest', async () => {
    const destinationPath = await destination()
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes)
      },
      cancel: cancelled
    })
    netFetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-length': String(bytes.length + 1) } })
    )

    await expect(
      downloadSshRelayArtifact({ artifact: selectedArtifact(), destinationPath })
    ).rejects.toThrow(/length/i)
    expect(cancelled).toHaveBeenCalledOnce()
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels a stalled body and removes partial output', async () => {
    const destinationPath = await destination()
    const controller = new AbortController()
    const cancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes.subarray(0, 3))
      },
      cancel: cancelled
    })
    netFetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-length': String(bytes.length) } })
    )

    const download = downloadSshRelayArtifact({
      artifact: selectedArtifact(),
      destinationPath,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(netFetchMock).toHaveBeenCalledOnce())
    controller.abort(new Error('cancel relay download'))

    await expect(download).rejects.toThrow(/cancel relay download/i)
    expect(cancelled).toHaveBeenCalledOnce()
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites an existing destination', async () => {
    const destinationPath = await destination()
    await writeFile(destinationPath, 'owner bytes')

    await expect(
      downloadSshRelayArtifact({ artifact: selectedArtifact(), destinationPath })
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(destinationPath, 'utf8')).toBe('owner bytes')
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
