import { executeWslWorktreePathOperation } from './wsl-worktree-path-operation'

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    throw new Error('WSL workspace materialization requires Node.js 18 or newer')
  }
  const request = JSON.parse(
    Buffer.from(process.env.ORCA_WORKTREE_REQUEST ?? '', 'base64').toString('utf8')
  )
  delete process.env.ORCA_WORKTREE_REQUEST
  const result = await executeWslWorktreePathOperation(request)
  process.stdout.write(JSON.stringify(result))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
