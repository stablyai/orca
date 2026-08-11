import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createMainProcessBootstrapPlugin } from './config/build-plugins/main-process-bootstrap'
import { createPlainNodeEntryGuardPlugin } from './config/build-plugins/plain-node-entry-guard'
import packageJson from './package.json' with { type: 'json' }

const BUNDLED_MAIN_DEPENDENCIES = new Set([
  '@xterm/headless',
  '@xterm/addon-serialize',
  'psl',
  // Why: Windows NSIS deploys app.asar before external resources; bootstrap must
  // not race the later resources/node_modules copy.
  'zod'
])
const EXTERNAL_MAIN_DEPENDENCIES = Object.keys(packageJson.dependencies).filter(
  (dependency) => !BUNDLED_MAIN_DEPENDENCIES.has(dependency)
)

function isExternalMainModule(source: string): boolean {
  if (isBuiltin(source) || source === 'electron' || source.startsWith('electron/')) {
    return true
  }
  return EXTERNAL_MAIN_DEPENDENCIES.some(
    (dependency) => source === dependency || source.startsWith(`${dependency}/`)
  )
}

// Why: the telemetry transport is gated by two compile-time constants that
// only the official CI release workflow sets. Contributor / `pnpm dev` /
// third-party rebuilds must substitute literal `null` at these sites so
// `IS_OFFICIAL_BUILD` in `src/main/telemetry/client.ts` evaluates `false`
// at module load and the track() wrapper short-circuits to console-mirror.
// The substitution happens at compile time — there is no runtime env-var
// fallback — so a curious contributor cannot spoof transmission with a
// shell export.
//
// CI injects real values via GitHub Actions secrets
// (ORCA_BUILD_IDENTITY='stable' | 'rc', ORCA_POSTHOG_WRITE_KEY=phc_...);
// every other build path resolves these env vars to undefined, which the
// JSON.stringify below folds to the literal `null`. Ambient declarations
// for the two constants live in `src/types/build-constants.d.ts`.
const orcaBuildIdentity = process.env.ORCA_BUILD_IDENTITY
const ORCA_BUILD_IDENTITY_LITERAL =
  orcaBuildIdentity === 'stable' || orcaBuildIdentity === 'rc'
    ? JSON.stringify(orcaBuildIdentity)
    : 'null'
const orcaPostHogWriteKey = process.env.ORCA_POSTHOG_WRITE_KEY
const ORCA_POSTHOG_WRITE_KEY_LITERAL =
  typeof orcaPostHogWriteKey === 'string' && orcaPostHogWriteKey.length > 0
    ? JSON.stringify(orcaPostHogWriteKey)
    : 'null'
const orcaDiagnosticsTokenUrl = process.env.ORCA_DIAGNOSTICS_TOKEN_URL
const ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL =
  typeof orcaDiagnosticsTokenUrl === 'string' && orcaDiagnosticsTokenUrl.length > 0
    ? JSON.stringify(orcaDiagnosticsTokenUrl)
    : 'null'

export const electronViteConfig: UserConfig = {
  main: {
    build: {
      // Why: daemon-entry.js is asar-unpacked so child_process.fork() can
      // execute it from disk. Node's module resolution from the unpacked
      // directory cannot reach into app.asar; startup-critical pure JS must
      // also survive a partially copied Windows resources tree.
      externalizeDeps: {
        exclude: [...BUNDLED_MAIN_DEPENDENCIES]
      },
      rollupOptions: {
        // Why: native dependencies must resolve from packaged node_modules,
        // while the unpacked daemon needs its pure-JS xterm graph bundled.
        external: isExternalMainModule,
        input: {
          index: resolve('src/main/index.ts'),
          // Why: sandboxed webview preloads cannot load Rollup helper chunks.
          'browser-window-close-preload': resolve('src/preload/browser-window-close.ts'),
          'daemon-entry': resolve('src/main/daemon/daemon-entry.ts'),
          'plugin-host-entry': resolve('src/main/plugins/plugin-host-entry.ts'),
          'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
          'stt-worker': resolve('src/main/speech/stt-worker.ts'),
          'warp-theme-parser-worker': resolve('src/main/warp-themes/warp-theme-parser-worker.ts'),
          'session-scanner-opencode-sqlite-worker-entry': resolve(
            'src/main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts'
          ),
          'session-scanner-worker-entry': resolve(
            'src/main/ai-vault/session-scanner-worker-entry.ts'
          ),
          'session-scanner-service-entry': resolve(
            'src/main/ai-vault/session-scanner-service-entry.ts'
          ),
          // Why: libuv spawns processes inline on the calling loop, so the port
          // scan's probe commands run on a worker thread instead of the UI one.
          'port-scan-command-worker-entry': resolve(
            'src/main/ports/port-scan-command-worker-entry.ts'
          ),
          // Why: forked with ELECTRON_RUN_AS_NODE so @parcel/watcher faults
          // can't take down the main process (issue #7547).
          'parcel-watcher-process-entry': resolve('src/main/ipc/parcel-watcher-process-entry.ts'),
          // Why: a worker thread survives the macOS 26 AppKit main-thread deadlock
          // without paying for another Electron process.
          'main-thread-hang-watchdog-entry': resolve(
            'src/main/hang-watchdog/main-thread-hang-watchdog-entry.ts'
          ),
          // Why: run under ELECTRON_RUN_AS_NODE while the caller blocks on
          // spawnSync — codex app-server trust grants need a live event loop
          // but must finish before a Codex pane launch proceeds.
          'codex/codex-app-server-grant-entry': resolve(
            'src/main/codex/codex-app-server-grant-entry.ts'
          ),
          // Why: electron-vite cleans out/main in dev. The dev CLI imports
          // this path for `orca agent hooks ...`, so it must survive rebuilds.
          'agent-hooks/managed-agent-hook-controls': resolve(
            'src/main/agent-hooks/managed-agent-hook-controls.ts'
          ),
          // Why: account import mutates the user's macOS Keychain from the CLI.
          'claude-accounts/keychain': resolve('src/main/claude-accounts/keychain.ts')
        },
        // Why: Rolldown's SSR default is ESM, but Electron and sidecar launchers
        // consume these stable CommonJS paths.
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        },
        plugins: [createMainProcessBootstrapPlugin(), createPlainNodeEntryGuardPlugin()]
      }
    },
    // Why: compile-time substitution for the telemetry gate. See the block
    // above for the full rationale.
    define: {
      ORCA_BUILD_IDENTITY: ORCA_BUILD_IDENTITY_LITERAL,
      ORCA_POSTHOG_WRITE_KEY: ORCA_POSTHOG_WRITE_KEY_LITERAL,
      ORCA_DIAGNOSTICS_TOKEN_URL: ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL
    },
    // Why: @xterm/headless declares "exports": null in package.json, which
    // prevents Vite's default resolver from finding the CJS entry. Point
    // directly at the published main file so the bundler can inline it.
    resolve: {
      alias: {
        '@xterm/headless': resolve('node_modules/@xterm/headless/lib-headless/xterm-headless.js'),
        '@xterm/addon-serialize': resolve(
          'node_modules/@xterm/addon-serialize/lib/addon-serialize.js'
        )
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ['@electron-toolkit/preload']
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    worker: {
      format: 'es'
    },
    build: {
      manifest: true,
      modulePreload: { polyfill: true },
      target: 'es2020',
      // Why: the pop-out dashboard is a second top-level window with its own
      // React root. It gets its own HTML entry so it can boot independently of
      // the main window while reusing the same preload/window.api. `index` must
      // stay listed — overriding input otherwise drops electron-vite's default
      // renderer entry.
      rollupOptions: {
        // Why: shared chunks must never import an HTML entry whose module mounts
        // a different React root.
        preserveEntrySignatures: 'strict',
        input: {
          index: resolve('src/renderer/index.html'),
          popout: resolve('src/renderer/popout.html'),
          web: resolve('src/renderer/web-index.html')
        }
      }
    }
  }
}

export default defineConfig(electronViteConfig)
