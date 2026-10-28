import { defaultExclude, mergeConfig } from 'vitest/config'
import original from '../mobile/vitest.config.ts'

// Keep real process, native, and runtime-specific contracts on Node.
const nodeFiles = [
  'scripts/check-tests-typecheck-incremental-cache.test.ts',
  'src/tasks/mobile-agent-launch-architecture.test.ts',
  'src/tasks/agent-launch-mobile-replay.test.ts',
  'src/mock-server-key-pair.test.ts',
  'src/mobile-release/prepare-android-release-script.test.ts',
  'src/navigation/query-string-named-exports.test.ts',
  'src/components/markdown-inline-matcher.test.ts',
  'src/components/mobile-markdown-parser-progress.test.ts',
  'src/components/pr-sidebar/markdown-tag-stripping-performance.test.ts',
  'src/components/pr-sidebar/markdown-table-delimiter-performance.test.ts',
  'src/components/rich-markdown/native-document-bundle.test.ts',
  'src/terminal/document/native-document-bundle.test.ts',
  'src/transport/settings-read-operations.test.ts',
  'src/transport/mobile-e2ee-v2-client-session.test.ts',
  'src/transport/mobile-e2ee-v2-physical-channel.test.ts',
  'src/transport/pairing-relay-served-recovery.test.ts',
  'src/transport/mobile-relay-rpc-stream-cancellation.test.ts',
  'src/test-support/rpc-recording/subscription-recording.test.ts',
  'src/test-support/rpc-recording/family-recordings.test.ts'
]

const config = mergeConfig(original, { cacheDir: process.env.ORCA_MOBILE_CI_CACHE_DIR })

// Assign include after merging: mergeConfig concatenates arrays.
export default {
  ...config,
  test: {
    ...config.test,
    isolate: true,
    ...(process.versions.bun
      ? {
          maxWorkers: 3,
          exclude: [...(config.test?.exclude ?? defaultExclude), ...nodeFiles]
        }
      : { maxWorkers: 1, include: nodeFiles })
  }
}
