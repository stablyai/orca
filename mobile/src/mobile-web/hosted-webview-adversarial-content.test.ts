import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHostedAdversarialRepositoryFixture,
  HOSTED_ADVERSARIAL_CONTENT,
  HOSTED_ADVERSARIAL_CONTENT_MARKER,
  HOSTED_ADVERSARIAL_FILENAME,
  HOSTED_ADVERSARIAL_FILENAME_MARKER,
  HOSTED_ADVERSARIAL_HTML_FILENAME,
  HOSTED_ADVERSARIAL_HTML_MARKER,
  HOSTED_ADVERSARIAL_IMAGE_FILENAME,
  HOSTED_ADVERSARIAL_IMAGE_MARKER,
  HOSTED_ADVERSARIAL_MARKDOWN_FILENAME,
  HOSTED_ADVERSARIAL_MARKDOWN_MARKER,
  HOSTED_ADVERSARIAL_SVG_FILENAME,
  HOSTED_ADVERSARIAL_SVG_MARKER,
  HOSTED_ADVERSARIAL_WORKSPACE_ROW,
  readHostedAdversarialRepositoryContent,
  removeHostedAdversarialRepositoryFixture
} from '../../scripts/hosted-adversarial-repository-fixture.mjs'
import {
  hostedWebViewAdversarialContentEvidence,
  hostedWebViewAdversarialContentObservations,
  verifyHostedWebViewAdversarialContent
} from '../../scripts/hosted-webview-adversarial-content.mjs'
import { hostedAdversarialFileExecutionEvidence } from '../../scripts/hosted-webview-adversarial-files.mjs'

const execFileAsync = promisify(execFile)
const fixtures: Awaited<ReturnType<typeof createHostedAdversarialRepositoryFixture>>[] = []
const androidHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-source-control-review-e2e.mjs', import.meta.url),
  'utf8'
)
const androidHarnessPath = fileURLToPath(
  new URL('../../scripts/run-hosted-android-source-control-review-e2e.mjs', import.meta.url)
)
const iosHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-webview-simulator-e2e.mjs', import.meta.url),
  'utf8'
)

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(removeHostedAdversarialRepositoryFixture))
})

describe('hosted WebView adversarial content', () => {
  it('creates one disposable hostile filename and diff', async () => {
    const fixture = await createHostedAdversarialRepositoryFixture({
      probePort: 54321
    })
    fixtures.push(fixture)

    const status = await execFileAsync('git', ['status', '--short'], {
      cwd: fixture.root,
      encoding: 'utf8'
    })
    expect(status.stdout).toContain(HOSTED_ADVERSARIAL_FILENAME_MARKER)
    const diff = await execFileAsync('git', ['diff', '--'], {
      cwd: fixture.root,
      encoding: 'utf8'
    })
    expect(diff.stdout).toContain(HOSTED_ADVERSARIAL_CONTENT_MARKER)
    expect(await readHostedAdversarialRepositoryContent(fixture)).toBe(
      `${HOSTED_ADVERSARIAL_CONTENT}\n`
    )
    const branch = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf8'
    })
    expect(branch.stdout.trim()).toBe(HOSTED_ADVERSARIAL_WORKSPACE_ROW)
    expect(fixture.workspaceRowName).toBe(HOSTED_ADVERSARIAL_WORKSPACE_ROW)
    expect(fixture.repositoryFiles.map(({ filename }) => filename)).toEqual([
      HOSTED_ADVERSARIAL_MARKDOWN_FILENAME,
      HOSTED_ADVERSARIAL_HTML_FILENAME,
      HOSTED_ADVERSARIAL_SVG_FILENAME,
      HOSTED_ADVERSARIAL_IMAGE_FILENAME
    ])
    expect(fixture.repositoryFiles.map(({ marker }) => marker)).toEqual([
      HOSTED_ADVERSARIAL_MARKDOWN_MARKER,
      HOSTED_ADVERSARIAL_HTML_MARKER,
      HOSTED_ADVERSARIAL_SVG_MARKER,
      HOSTED_ADVERSARIAL_IMAGE_MARKER
    ])
    for (const file of fixture.repositoryFiles) {
      const content = await readFile(path.join(fixture.root, file.filename))
      expect(content).toEqual(Buffer.from(file.content))
      expect(content.includes(file.marker)).toBe(true)
      expect(content.includes('http://127.0.0.1:54321/')).toBe(true)
    }
  })

  it('accepts literal markers without created elements or execution', () => {
    expect(
      hostedWebViewAdversarialContentEvidence({
        text: `${HOSTED_ADVERSARIAL_FILENAME}\n${HOSTED_ADVERSARIAL_CONTENT}`,
        execution: {
          filenameExecuted: false,
          contentExecuted: false,
          injectedImageCount: 0
        }
      })
    ).toEqual({
      filenameRenderedAsText: true,
      diffRenderedAsText: true,
      injectedImageCount: 0,
      scriptMarkersExecuted: false
    })
  })

  it('aggregates literal markers across route documents', async () => {
    const values = [
      JSON.stringify({
        href: 'https://orca-mobile-web.invalid/source-control',
        bodyText: HOSTED_ADVERSARIAL_FILENAME,
        labels: [],
        placeholders: []
      }),
      JSON.stringify({
        filenameExecuted: false,
        contentExecuted: false,
        injectedImageCount: 0
      }),
      JSON.stringify({
        href: 'https://orca-mobile-web.invalid/session',
        bodyText: HOSTED_ADVERSARIAL_CONTENT,
        labels: [],
        placeholders: []
      }),
      JSON.stringify({
        filenameExecuted: false,
        contentExecuted: false,
        injectedImageCount: 0
      })
    ]
    class FakeWebSocket {
      private message: ((data: Buffer) => void) | undefined

      once(event: string, listener: () => void) {
        if (event === 'open') {
          queueMicrotask(listener)
        }
      }

      on(event: string, listener: (data: Buffer) => void) {
        if (event === 'message') {
          this.message = listener
        }
      }

      send(payload: string) {
        const id = JSON.parse(payload).id
        const value = values.shift()
        queueMicrotask(() => {
          this.message?.(
            Buffer.from(JSON.stringify({ id, result: { result: { value: value ?? '' } } }))
          )
        })
      }

      close() {}
    }

    await expect(
      verifyHostedWebViewAdversarialContent({
        documents: [
          { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/source' },
          { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/session' }
        ],
        WebSocketCtor: FakeWebSocket as never
      })
    ).resolves.toMatchObject({
      filenameRenderedAsText: true,
      diffRenderedAsText: true,
      scriptMarkersExecuted: false
    })
  })

  it('rejects missing literal markers and executed content', () => {
    expect(() =>
      hostedWebViewAdversarialContentEvidence({
        text: HOSTED_ADVERSARIAL_FILENAME,
        execution: {
          filenameExecuted: false,
          contentExecuted: false,
          injectedImageCount: 0
        }
      })
    ).toThrow('was not rendered')
    expect(() =>
      hostedWebViewAdversarialContentEvidence({
        text: `${HOSTED_ADVERSARIAL_FILENAME}\n${HOSTED_ADVERSARIAL_CONTENT}`,
        execution: {
          filenameExecuted: false,
          contentExecuted: true,
          injectedImageCount: 1
        }
      })
    ).toThrow('content executed')
  })

  it('rejects malformed execution observations without coercion', () => {
    expect(() =>
      hostedWebViewAdversarialContentObservations([
        {
          state: {
            bodyText: `${HOSTED_ADVERSARIAL_FILENAME}\n${HOSTED_ADVERSARIAL_CONTENT}`,
            labels: []
          },
          execution: {
            filenameExecuted: 'false',
            contentExecuted: false,
            injectedImageCount: 0
          }
        }
      ])
    ).toThrow('content executed')
  })

  it('rejects malformed repository-file execution evidence', () => {
    expect(
      hostedAdversarialFileExecutionEvidence({
        markers: [false, false, false, false],
        injectedElementCount: 0
      })
    ).toEqual({
      injectedElementCount: 0,
      repositoryFileScriptMarkersExecuted: false
    })
    expect(() =>
      hostedAdversarialFileExecutionEvidence({
        markers: [false, 'false', false, false],
        injectedElementCount: 0
      })
    ).toThrow('repository file executed')
  })

  it('keeps the disposable corpus wired into the exact Android route gate', () => {
    expect(androidHarnessSource).toContain('createHostedAdversarialRuntimeFixture')
    expect(androidHarnessSource).toContain('captureHostedWebViewAdversarialObservation')
    expect(androidHarnessSource).toContain('hostedWebViewAdversarialContentObservations')
    expect(androidHarnessSource).toContain('removeHostedAdversarialRuntimeFixture')
  })

  it('rejects conflicting Android security journeys before device access', async () => {
    await expect(
      execFileAsync(process.execPath, [
        androidHarnessPath,
        '--adversarial-content',
        '--security-only'
      ])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('mutually exclusive')
    })
  })

  it('keeps the same disposable corpus wired into the exact iOS route gate', () => {
    expect(iosHarnessSource).toContain('registerHostedIosAdversarialRepository')
    expect(iosHarnessSource).toContain('createHostedIosAdversarialContentInspector')
    expect(iosHarnessSource).toContain('removeHostedAdversarialRuntimeFixture')
  })
})
