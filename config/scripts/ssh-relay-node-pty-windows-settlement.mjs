import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const conptyDllKillSequence = `                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._outSocket.on('data', function () {
                    _this._conoutSocketWorker.dispose();
                });`

const settledConptyDllKillSequence = `                this._ptyNative.kill(this._pty, this._useConptyDll);
                // Why: quiet ConPTY output cannot retrigger disposal, so start its bounded drain now.
                this._conoutSocketWorker.dispose();
                this._outSocket.on('data', function () {
                    _this._conoutSocketWorker.dispose();
                });`

export async function applyWindowsNodePtySettlement({ nodePtyLibraryDirectory, tuple }) {
  if (!tuple.startsWith('win32-')) {
    return { applied: false }
  }

  const agentPath = join(nodePtyLibraryDirectory, 'windowsPtyAgent.js')
  const source = await readFile(agentPath, 'utf8')
  const matchCount = source.split(conptyDllKillSequence).length - 1
  if (matchCount !== 1) {
    throw new Error(
      `expected exactly one DLL-mode ConPTY worker settlement sequence; found ${matchCount}`
    )
  }

  await writeFile(agentPath, source.replace(conptyDllKillSequence, settledConptyDllKillSequence))
  return { applied: true }
}
