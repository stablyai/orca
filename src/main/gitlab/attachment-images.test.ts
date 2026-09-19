import { beforeEach, describe, expect, it, vi } from 'vitest'
const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))
vi.mock('../git/command-runner/exec-file-capture', () => ({ execFileCapture: capture }))
vi.mock('../git/command-runner/wsl-command-resolution', () => ({
  resolveCommand: (binary: string, args: string[], cwd?: string) => ({ binary, args, cwd })
}))
import { collectGitLabImages, gitLabUploadPath, loadGitLabImages } from './attachment-images'
const project = { host: 'gitlab.example.com', path: 'group/project' }
const src = '/uploads/0123456789abcdef0123456789abcdef/screen.png'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
  'base64'
)

describe('GitLab attachment images', () => {
  beforeEach(() => {
    capture.mockReset()
  })
  it('resolves relative and same-project URLs without accepting other origins or traversal', () => {
    const endpoint = `projects/group%2Fproject${src}`
    expect(gitLabUploadPath(src, project)).toBe(endpoint)
    expect(gitLabUploadPath(`https://${project.host}/${project.path}${src}`, project)).toBe(
      endpoint
    )
    for (const invalid of [
      `https://evil.test${src}`,
      `https://${project.host}/other/project${src}`,
      src.replace('screen.png', '..%2Fsecret'),
      `//evil.test${src}`,
      `${src}?redirect=evil`,
      `${src}#fragment`,
      src.replace('screen.png', '%00.png'),
      src.replace('screen.png', '%5csecret'),
      src.replace('screen.png', '%broken'),
      `https://user:password@${project.host}/${project.path}${src}`
    ]) {
      expect(gitLabUploadPath(invalid, project)).toBeNull()
    }
  })
  it('finds inline, reference and HTML images but ignores code and ordinary links', () => {
    expect(
      collectGitLabImages([
        `![a](${src})\n![b][ref]\n\n[ref]: /uploads/ref.png\n\n<img src="/uploads/html.png">\n\n\`![code](/uploads/code.png)\`\n[link](/uploads/file.png)`
      ])
    ).toEqual([src, '/uploads/ref.png', '/uploads/html.png'])
  })
  it('preserves binary bytes, pins the GitLab host and deduplicates requests', async () => {
    capture.mockResolvedValue({ stdout: png, stderr: Buffer.alloc(0) })
    const full = `https://${project.host}/${project.path}${src}`
    const result = await loadGitLabImages([`![a](${src}) ![b](${full})`], '/repo', project)
    expect(result[src]).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(result[full]).toBe(result[src])
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(
      'glab',
      ['api', '--hostname', project.host, `projects/group%2Fproject${src}`],
      expect.objectContaining({ cwd: '/repo', encoding: 'buffer', timeout: 15000 })
    )
  })
  it('keeps failures, HTML login pages and SVG out of the image map', async () => {
    for (const bytes of [Buffer.from('<html>Sign in</html>'), Buffer.from('<svg/>')]) {
      capture.mockResolvedValue({ stdout: bytes })
      expect(await loadGitLabImages([`![a](${src})`], '/repo', project)).toEqual({})
    }
    capture.mockRejectedValue(new Error('404'))
    expect(await loadGitLabImages([`![a](${src})`], '/repo', project)).toEqual({})
  })
})

describe('GitLab attachment budgets and host routing', () => {
  beforeEach(() => capture.mockReset())

  it('encodes filenames once, including spaces and Unicode', () => {
    const filename = encodeURIComponent('снимок экрана.png')
    expect(gitLabUploadPath(src.replace('screen.png', filename), project)).toBe(
      `projects/group%2Fproject${src.replace('screen.png', filename)}`
    )
  })

  it('never downloads external images or ordinary attachment links', async () => {
    expect(
      await loadGitLabImages([`![a](https://other.test${src}) [file](${src})`], '/repo', project)
    ).toEqual({})
    expect(capture).not.toHaveBeenCalled()
  })

  it('keeps remote repository paths off the local API process', async () => {
    capture.mockResolvedValue({ stdout: png })
    await loadGitLabImages([`![a](${src})`], '/remote-only/repo', project, 'ssh-connection')
    expect(capture).toHaveBeenCalledWith(
      'glab',
      expect.any(Array),
      expect.objectContaining({ cwd: undefined })
    )
  })

  it('uses the ported GitLab host through the existing environment mapping', async () => {
    capture.mockResolvedValue({ stdout: png })
    await loadGitLabImages([`![a](${src})`], '/repo', {
      ...project,
      host: 'gitlab.example.com:8443'
    })
    expect(capture).toHaveBeenCalledWith(
      'glab',
      ['api', `projects/group%2Fproject${src}`],
      expect.objectContaining({
        env: expect.objectContaining({ GITLAB_HOST: 'gitlab.example.com:8443' })
      })
    )
  })

  it('limits unique downloads and keeps successful previews when another fails', async () => {
    capture.mockRejectedValueOnce(new Error('404')).mockResolvedValue({ stdout: png })
    const content = Array.from(
      { length: 20 },
      (_, i) => `![${i}](${src.replace('screen.png', `${i}.png`)})`
    ).join(' ')
    const result = await loadGitLabImages([content], '/repo', project)
    expect(capture).toHaveBeenCalledTimes(16)
    expect(Object.keys(result)).toHaveLength(15)
  })

  it('rejects oversized files and caps the serialized image map including aliases', async () => {
    capture.mockResolvedValue({ stdout: Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]) })
    expect(await loadGitLabImages([`![a](${src})`], '/repo', project)).toEqual({})
    capture.mockResolvedValue({ stdout: Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]) })
    const content = Array.from({ length: 10 }, (_, i) => {
      const path = src.replace('screen.png', `${i}.png`)
      return `![a](${path}) ![b](https://${project.host}/${project.path}${path})`
    }).join(' ')
    const result = await loadGitLabImages([content], '/repo', project)
    expect(Object.keys(result).length).toBeGreaterThan(0)
    expect(Object.values(result).reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(
      16 * 1024 * 1024
    )
  })
})

describe('HTML image syntax and serialized budgets', () => {
  it.each([
    `<img src = "${src}">`,
    `<img SRC = '${src}'>`,
    `<img src=${src}>`,
    `<img\nsrc\t=\t"${src}">`,
    `<img title="a > b" src="${src}">`,
    `<img data-src="/wrong.png" src="${src}">`
  ])('extracts the actual src from %s', (html) => {
    expect(collectGitLabImages([html])).toEqual([src])
  })
  it('ignores data attributes and attribute text that mentions src', () => {
    expect(collectGitLabImages([`<img data-src="${src}" title='src="${src}"'>`])).toEqual([])
  })
  it('accounts for UTF-8 keys, JSON escaping and aliases in a remote budget', async () => {
    capture.mockReset().mockResolvedValue({ stdout: png })
    const path = src.replace('screen.png', 'снимок.png')
    const full = `https://${project.host}/${project.path}${path}`
    const budget = 180
    const result = await loadGitLabImages(
      [`![a](${path}) ![b](${full})`],
      '/repo',
      project,
      null,
      {},
      budget
    )
    expect(Object.keys(result)).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(result)) - 2).toBeLessThanOrEqual(budget)
  })
})
