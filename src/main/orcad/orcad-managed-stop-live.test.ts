import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  spawnProcess,
  runProcess,
  type SpawnedProcess
} from '../../shared/child-process/run-process'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { decodePairingOffer } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import {
  OrcadManagedStopIdentitySchema,
  OrcadManagedDecommissionResultSchema
} from '../../shared/orcad-managed-decommission'
import {
  emptyOrcadActivationRecord,
  withDecommissioningVersion,
  withDeactivatedVersion
} from '../ssh/orcad-activation-record'
import { createOrcadDecommissionTransaction } from '../ssh/orcad-activation-transaction'
import {
  ORCAD_COMPLETED_STOP_RECEIPT_FILENAME,
  parseOrcadCompletedStopReceipt
} from '../ssh/orcad-completed-stop-receipt'
import { parseManagedStopOrcadCompletion } from '../ssh/orcad-managed-stop-process-command'
import { OrcadManagedStopCancellationResultSchema } from '../../shared/orcad-managed-stop-cancellation'
import { readOrcadCanceledStopReceipt } from './orcad-canceled-stop-receipt'

function ready(child: SpawnedProcess): Promise<{ pairing: { url: string }; runtimeId: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(
      () => reject(new Error(`Runtime readiness timed out: ${errors}`)),
      // Installed-browser discovery can spend 120 seconds before terminal-only fallback.
      150_000
    )
    child.stderr?.on('data', (chunk) => {
      errors = (errors + String(chunk)).slice(-16_384)
    })
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
      let newline: number
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline)
        output = output.slice(newline + 1)
        try {
          const message = JSON.parse(line)
          if (message.type === 'orca_server_ready') {
            clearTimeout(timer)
            resolve(message)
          }
        } catch {
          /* Readiness shares stdout with startup diagnostics. */
        }
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Runtime exited ${code}: ${errors}`))
    })
  })
}

function waitForExit(child: SpawnedProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture runtime did not exit')), 20_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

it.skipIf(!process.env.ORCA_TEST_ORCAD_ENTRY)(
  'preserves a live folder terminal, then stops and recovers without stopping a replacement',
  async () => {
    const entry = process.env.ORCA_TEST_ORCAD_ENTRY!
    const runtime = join(dirname(entry), orcadBunRuntimeFilename(process.platform))
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orcad-live-stop-')))
    const privateHome = join(root, 'home')
    const dataRoot = join(root, 'data')
    mkdirSync(privateHome)
    const version = '0.1.0+managed-stop-live-test'
    // These remain the child's home settings; the parent environment is never changed.
    const env = {
      ...process.env,
      VITEST: undefined,
      ORCA_DAEMON_ENTRY_LOAD_CHECK: undefined,
      HOME: privateHome,
      USERPROFILE: privateHome,
      ORCA_USER_DATA: dataRoot,
      ORCA_VERSION: version
    }
    let diagnostics = ''
    const launch = () => {
      const child = spawnProcess({ program: runtime, args: [entry, '--port', '0', '--json'], env })
      child.stderr?.on('data', (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-32_768)
      })
      return child
    }
    const children: SpawnedProcess[] = []
    let passed = false
    try {
      const child = launch()
      children.push(child)
      const serving = await ready(child)
      const pairing = decodePairingOffer(serving.pairing.url)
      const rpc = (method: string, params: unknown) =>
        sendRemoteRuntimeRequest(
          pairing,
          method,
          params,
          30_000,
          undefined,
          undefined,
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
        )
      const response = await rpc('orcad.managedStopIdentity', null)
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const identity = OrcadManagedStopIdentitySchema.parse(response.result)
      const checkedRpc = async (method: string, params: unknown) => {
        const result = await rpc(method, params)
        if (!result.ok) {
          throw new Error(`${method}: ${result.error.message}`)
        }
        return result.result
      }
      const folderPath = join(root, 'workspace')
      mkdirSync(folderPath)
      const { group } = z
        .object({ group: z.object({ id: z.string() }) })
        .parse(
          await checkedRpc('projectGroup.create', { name: 'Stop preservation', parentPath: root })
        )
      const { folderWorkspace } = z
        .object({ folderWorkspace: z.object({ id: z.string() }) })
        .parse(await checkedRpc('folderWorkspace.create', { projectGroupId: group.id, folderPath }))
      const { terminal } = z
        .object({ terminal: z.object({ handle: z.string() }) })
        .parse(
          await checkedRpc('terminal.create', { worktree: folderWorkspaceKey(folderWorkspace.id) })
        )
      const verifyTerminal = async () => {
        const nonce = randomUUID().replaceAll('-', '')
        // Require an output-only line so echoed input cannot satisfy the assertion.
        await checkedRpc('terminal.send', {
          terminal: terminal.handle,
          text: `echo ${nonce}`,
          enter: true
        })
        await expect
          .poll(
            async () => {
              const read = z
                .object({ terminal: z.object({ tail: z.array(z.string()) }) })
                .parse(await checkedRpc('terminal.read', { terminal: terminal.handle }))
              return read.terminal.tail.some((line) => line.trim() === nonce)
            },
            { timeout: 15_000 }
          )
          .toBe(true)
      }
      await verifyTerminal()
      expect(identity.completedStopReceipt).toBe(1)
      expect(identity.instance?.pid).toBe(child.pid)
      expect(relative(realpathSync(dataRoot), identity.identity.profileRoot)).not.toMatch(/^\.\./)
      let authority = { ...identity.identity, transactionId: randomUUID() }
      const before = {
        ...emptyOrcadActivationRecord(),
        active: version,
        activatedAt: new Date().toISOString()
      }
      const accepted = withDecommissioningVersion(before, new Date())
      let transaction = createOrcadDecommissionTransaction({
        transactionId: authority.transactionId,
        authority,
        instance: identity.instance!,
        activeVersion: version,
        recordBefore: before,
        acceptedRecord: accepted,
        recordAfter: withDeactivatedVersion(accepted),
        now: new Date()
      })
      const controlRoot = join(privateHome, '.orca-remote')
      const transactionRoot = join(controlRoot, '.orcad-activation-transaction')
      mkdirSync(transactionRoot, { recursive: true })
      const transactionPath = join(transactionRoot, 'transaction.json')
      const activationPath = join(controlRoot, 'orcad-active.json')
      expect(writeDurableSecureJsonFile(activationPath, before)).toBe(true)
      expect(writeDurableSecureJsonFile(transactionPath, transaction)).toBe(true)
      expect(
        OrcadManagedDecommissionResultSchema.parse(
          await checkedRpc('orcad.decommissionManagedIfIdle', { version, authority })
        )
      ).toMatchObject({ outcome: 'refused', verdict: 'live', terminalAdmission: 'open' })
      expect(JSON.parse(readFileSync(activationPath, 'utf8'))).toEqual(before)
      expect(JSON.parse(readFileSync(transactionPath, 'utf8'))).toEqual(transaction)
      expect(identity.cancelPreparedStop).toBe(1)
      const canceledRequest = {
        schemaVersion: 1 as const,
        version,
        authority,
        instance: identity.instance!
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          OrcadManagedStopCancellationResultSchema.parse(
            await checkedRpc('orcad.cancelPreparedStop', canceledRequest)
          )
        ).toEqual({ ...canceledRequest, outcome: 'canceled' })
      }
      expect(readOrcadCanceledStopReceipt(privateHome, canceledRequest)).toBe(true)
      expect(
        OrcadManagedDecommissionResultSchema.parse(
          await checkedRpc('orcad.decommissionManagedIfIdle', { version, authority })
        )
      ).toMatchObject({
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_decommission_transaction_unverifiable'
      })
      expect(JSON.parse(readFileSync(activationPath, 'utf8'))).toEqual(before)
      expect(JSON.parse(readFileSync(transactionPath, 'utf8'))).toEqual(transaction)
      await verifyTerminal()
      const { terminal: admitted } = z.object({ terminal: z.object({ handle: z.string() }) }).parse(
        await checkedRpc('terminal.create', {
          worktree: folderWorkspaceKey(folderWorkspace.id)
        })
      )
      expect(admitted.handle).not.toBe(terminal.handle)
      await checkedRpc('terminal.close', { terminal: admitted.handle })
      await checkedRpc('terminal.close', { terminal: terminal.handle })
      // Only a new explicit stop transaction may proceed after cancellation.
      authority = { ...authority, transactionId: randomUUID() }
      transaction = { ...transaction, transactionId: authority.transactionId, authority }
      expect(writeDurableSecureJsonFile(transactionPath, transaction)).toBe(true)
      const decommission = await rpc('orcad.decommissionManagedIfIdle', { version, authority })
      if (!decommission.ok) {
        throw new Error(decommission.error.message)
      }
      expect(OrcadManagedDecommissionResultSchema.parse(decommission.result)).toEqual({
        outcome: 'accepted',
        authority,
        transactionId: authority.transactionId
      })
      expect(JSON.parse(readFileSync(activationPath, 'utf8'))).toEqual(accepted)
      const request = {
        schemaVersion: 1 as const,
        version,
        authority,
        instance: identity.instance!
      }
      const complete = async () => {
        const result = await runProcess({
          program: runtime,
          args: [entry, '--complete-managed-stop', JSON.stringify(request), privateHome],
          env,
          timeoutMs: 30_000
        })
        expect(result.code, result.stderr).toBe(0)
        return parseManagedStopOrcadCompletion(result.stdout, request)
      }
      expect(await complete()).toBe('exited')
      await waitForExit(child)
      expect(child.exitCode).toBe(0)
      const archive = parseOrcadCompletedStopReceipt(
        readFileSync(join(controlRoot, ORCAD_COMPLETED_STOP_RECEIPT_FILENAME), 'utf8')
      )
      if (archive.state !== 'ok') {
        throw new Error('Live stop did not archive its original instance')
      }
      expect(archive.transaction.instance).toEqual(identity.instance)
      expect(writeDurableSecureJsonFile(activationPath, transaction.recordAfter)).toBe(true)
      rmSync(transactionRoot, { recursive: true })
      mkdirSync(transactionRoot)
      expect(writeDurableSecureJsonFile(transactionPath, archive.transaction)).toBe(true)
      expect(await complete()).toBe('exited')

      const replacement = launch()
      children.push(replacement)
      await ready(replacement)
      expect(await complete()).toBe('unverifiable')
      expect(replacement.exitCode).toBeNull()
      replacement.kill('SIGTERM')
      await waitForExit(replacement)
      expect(replacement.exitCode).toBe(0)
      expect(await complete()).toBe('exited')
      passed = true
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          await waitForExit(child)
        }
      }
      if (passed) {
        rmSync(root, { recursive: true, force: true })
      } else {
        console.error(`Preserved failed managed-stop fixture: ${root}`)
        console.error(diagnostics)
      }
    }
  },
  360_000
)
