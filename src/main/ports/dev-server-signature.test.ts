import { describe, expect, it } from 'vitest'
import { identifyDevServer } from './dev-server-signature'

// Command lines below are shaped the way each platform actually reports them:
//   Linux   -> /proc/<pid>/cmdline, NUL separators joined with spaces
//   macOS   -> `ps -o command=`, absolute argv0, unquoted
//   Windows -> Win32_Process.CommandLine, quoted paths with backslashes
describe('identifyDevServer', () => {
  it.each([
    [
      'vite via the bin shim (linux)',
      'node /home/dev/app/node_modules/.bin/vite --port 5173',
      'Vite'
    ],
    [
      'vite via the package entry (macos)',
      '/usr/local/bin/node /Users/dev/app/node_modules/vite/bin/vite.js',
      'Vite'
    ],
    [
      'vite with a quoted windows path',
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\src\\app\\node_modules\\vite\\bin\\vite.js"',
      'Vite'
    ],
    ['next dev', 'node /home/dev/app/node_modules/.bin/next dev --turbopack', 'Next.js'],
    ['nuxt', 'node /home/dev/app/node_modules/.bin/nuxt dev', 'Nuxt'],
    ['astro', 'node /home/dev/app/node_modules/.bin/astro dev', 'Astro'],
    ['angular', 'node /home/dev/app/node_modules/@angular/cli/bin/ng.js serve', 'Angular'],
    [
      'create react app',
      'node /home/dev/app/node_modules/.bin/react-scripts start',
      'Create React App'
    ],
    ['webpack dev server', 'node /home/dev/app/node_modules/.bin/webpack serve', 'webpack'],
    ['storybook', 'node /home/dev/app/node_modules/.bin/storybook dev -p 6006', 'Storybook'],
    ['django', 'python3 manage.py runserver 0.0.0.0:8000', 'Django'],
    ['uvicorn', '/usr/bin/python3 /usr/local/bin/uvicorn main:app --reload', 'Uvicorn'],
    ['flask', '/usr/bin/python3 -m flask run --debug', 'Flask'],
    ['rails server', '/usr/bin/ruby bin/rails server -p 3000', 'Rails'],
    ['laravel', 'php artisan serve --port=8000', 'Laravel'],
    ['phoenix', '/usr/bin/elixir -S mix phx.server', 'Phoenix'],
    ['hugo', '/usr/local/bin/hugo server -D', 'Hugo']
  ])('identifies %s', (_case, commandLine, label) => {
    expect(identifyDevServer({ commandLine })?.label).toBe(label)
  })

  // Captured verbatim from `ps -o command=` against live processes, which is
  // how these reach the classifier in production.
  it.each([
    [
      'vite through the bin shim, as macOS reports it',
      'node node_modules/.bin/../vite/bin/vite.js --config vite.web.config.ts --port 5173 --host 127.0.0.1',
      'Vite'
    ],
    [
      'electron-vite from a pnpm virtual store path',
      '/Users/dev/.nvm/versions/node/v24.18.0/bin/node /repo/node_modules/.pnpm/electron-vite@5.0.0_rolldown-vite@7.3.1/node_modules/electron-vite/bin/electron-vite.js dev --remote-debugging-port=9453',
      'electron-vite'
    ]
  ])('identifies %s', (_case, commandLine, label) => {
    expect(identifyDevServer({ commandLine })?.label).toBe(label)
  })

  it('reports the server, not a framework, when only puma is visible', () => {
    // Sinatra, Hanami, Roda and bare `bundle exec puma` are indistinguishable
    // here, so naming this "Rails" would be wrong for every one of them.
    expect(identifyDevServer({ commandLine: 'puma 6.4.2 (tcp://0.0.0.0:3000) [app]' })?.label).toBe(
      'Puma'
    )
    expect(
      identifyDevServer({ commandLine: '/usr/bin/ruby bin/rails server -p 3000' })?.label
    ).toBe('Rails')
  })

  it('identifies next.js from the rewritten process title alone', () => {
    // Next renames its process once booted, so argv0 no longer mentions `next`.
    expect(identifyDevServer({ processName: 'next-server (v15.0.0)' })?.label).toBe('Next.js')
  })

  it('falls back to the package manager script when the framework is hidden', () => {
    expect(identifyDevServer({ commandLine: 'npm run dev' })).toEqual({
      id: 'npm-script',
      label: 'npm dev'
    })
    expect(identifyDevServer({ commandLine: '/usr/bin/pnpm dev' })?.label).toBe('pnpm dev')
  })

  it('prefers the framework over the package manager that launched it', () => {
    expect(identifyDevServer({ commandLine: 'pnpm exec vite dev' })?.label).toBe('Vite')
  })

  it('does not pair a process name with a script token from elsewhere in argv', () => {
    // `npm` + `dev` are both present, but only across the two fields. Joining
    // them would invent an `npm dev` script this process is not running.
    expect(identifyDevServer({ processName: 'npm', commandLine: 'node dev.js' })).toBeUndefined()
  })

  it('returns undefined for a plain node process so callers keep the process name', () => {
    expect(identifyDevServer({ processName: 'node', commandLine: 'node index.js' })).toBeUndefined()
  })

  it('returns undefined when no command line was collected', () => {
    expect(identifyDevServer({ processName: 'node' })).toBeUndefined()
    expect(identifyDevServer({})).toBeUndefined()
  })

  it('does not match a directory that merely shares a framework name', () => {
    // The worktree path lands in argv for attribution; it must not be read as
    // evidence of the framework itself.
    expect(
      identifyDevServer({ commandLine: 'node /home/dev/vite-playground/server.js' })
    ).toBeUndefined()
    expect(identifyDevServer({ commandLine: 'node /home/dev/next/build/index.js' })).toBeUndefined()
  })

  it('is case insensitive across windows executable casing', () => {
    expect(
      identifyDevServer({ commandLine: '"C:\\src\\app\\node_modules\\.bin\\Vite.CMD"' })?.label
    ).toBe('Vite')
  })

  it('keeps quoted paths containing spaces intact', () => {
    expect(
      identifyDevServer({
        commandLine:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\My Apps\\web\\node_modules\\.bin\\next" dev'
      })?.label
    ).toBe('Next.js')
  })
})
