import { readFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

import { getDefaultPersistedState } from '../../../shared/constants'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'

export async function buildCanonicalRunWorkers(bundleRoot: string): Promise<void> {
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts'),
      resolve('src/main/workspace-surfaces/surface-executor-reader-entry.ts')
    ],
    outdir: bundleRoot,
    entryNames: '[name]',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
}

export function canonicalRunWorkerOptions(bundleRoot: string) {
  return {
    workerPath: join(bundleRoot, 'profile-state-writer-worker-entry.js'),
    backupWorkerPath: join(bundleRoot, 'profile-state-backup-worker-entry.js')
  }
}

export function seedCanonicalMoveProfile(
  directory: string,
  pane: { worktreeId: string; tabId: string; leafId: string }
): void {
  const state = getDefaultPersistedState(directory)
  state.sshRemotePtyLeases = [
    {
      targetId: 'host',
      ptyId: 'pending-resource',
      createdAt: 1,
      updatedAt: 1,
      ...pane,
      state: 'attached'
    }
  ]
  writeFileSync(join(directory, 'orca-data.json'), JSON.stringify(state))
}

/** Test-only bundle counters observe actual workers without adding a production request or payload. */
export async function buildCanonicalRunProbeWorkers(bundleRoot: string) {
  const profileMetrics = join(bundleRoot, 'profile-probe.json')
  const executorMetrics = join(bundleRoot, 'executor-probe.json')
  const sources = [
    [
      'src/main/persistence/profile-state/profile-state-writer-worker-entry.ts',
      'probe-profile.js',
      profileMetrics
    ],
    [
      'src/main/workspace-surfaces/surface-executor-reader-entry.ts',
      'probe-executor.js',
      executorMetrics
    ]
  ]
  for (const [source, output, metrics] of sources) {
    await build({
      entryPoints: [resolve(source!)],
      outfile: join(bundleRoot, output!),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      banner: {
        js: `var __probe={rootDecodes:0,rootReadBytes:0,rootSerializedBytes:0,hashBytes:0,targetRecords:0,transferBytes:0,projected:[]}; function __probeSerialize(value){var text=JSON.stringify(value);__probe.rootSerializedBytes+=Buffer.byteLength(text);return text} function __probeReply(value){__probe.transferBytes+=Buffer.byteLength(JSON.stringify(value));require('node:fs').writeFileSync(${JSON.stringify(metrics)},JSON.stringify(__probe));return value}`
      },
      plugins: [
        {
          name: 'canonical-worker-counts',
          setup(plugin) {
            plugin.onLoad(
              {
                filter:
                  /(?:surface-profile-cache|surface-profile-save|surface-owner-command|surface-profile-storage|surface-owner-read|surface-layout|profile-state-document-validation|profile-state-writer-worker-entry|surface-executor-reader-entry)\.ts$/
              },
              async (args) => {
                let text = await readFile(args.path, 'utf8')
                text = text.replace(
                  'const document = row ? validateProfileStateDocumentRow',
                  'if(row){__probe.rootDecodes+=1;__probe.rootReadBytes+=Buffer.byteLength(String(row.payload))} const document = row ? validateProfileStateDocumentRow'
                )
                text = text
                  .replaceAll('JSON.stringify(committed)', '__probeSerialize(committed)')
                  .replaceAll('JSON.stringify(next)', '__probeSerialize(next)')
                text = text.replace(
                  "  return createHash('sha256').update(payload, 'utf8').digest('hex')",
                  "  __probe.hashBytes+=Buffer.byteLength(payload); return createHash('sha256').update(payload, 'utf8').digest('hex')"
                )
                text = text.replace(
                  '  const views = new Map(view?.tabs',
                  '  __probe.projected.push(workspaceId); const views = new Map(view?.tabs'
                )
                text = text.replace(
                  '    const index = root.hosts.get(request.hostId)!',
                  '    __probe.targetRecords+=1; const index = root.hosts.get(request.hostId)!'
                )
                text = text
                  .replace('port.postMessage(response)', 'port.postMessage(__probeReply(response))')
                  .replace(
                    'port.postMessage({ id: message.id, intent })',
                    'port.postMessage(__probeReply({ id: message.id, intent }))'
                  )
                return { contents: text, loader: 'ts' }
              }
            )
          }
        }
      ]
    })
  }
  return {
    workerPath: join(bundleRoot, 'probe-profile.js'),
    executorPath: join(bundleRoot, 'probe-executor.js'),
    profileMetrics,
    executorMetrics
  }
}

export const canonicalWorkerProbeSchema = z.object({
  rootDecodes: z.number(),
  rootReadBytes: z.number(),
  rootSerializedBytes: z.number(),
  hashBytes: z.number(),
  targetRecords: z.number(),
  transferBytes: z.number(),
  projected: z.array(z.string())
})
export function readCanonicalWorkerProbe(path: string) {
  return canonicalWorkerProbeSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}
