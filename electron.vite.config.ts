import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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

export default defineConfig({
  main: {
    build: {
      // Why: daemon-entry.js is asar-unpacked so child_process.fork() can
      // execute it from disk. Node's module resolution from the unpacked
      // directory cannot reach into app.asar, so pure-JS dependencies used
      // by the daemon must be bundled rather than externalized.
      externalizeDeps: {
        exclude: ['@xterm/headless', '@xterm/addon-serialize']
      },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'daemon-entry': resolve('src/main/daemon/daemon-entry.ts'),
          'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
          'stt-worker': resolve('src/main/speech/stt-worker.ts')
        }
      }
    },
    // Why: compile-time substitution for the telemetry gate. See the block
    // above for the full rationale.
    define: {
      ORCA_BUILD_IDENTITY: ORCA_BUILD_IDENTITY_LITERAL,
      ORCA_POSTHOG_WRITE_KEY: ORCA_POSTHOG_WRITE_KEY_LITERAL
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
    }
  }
})
