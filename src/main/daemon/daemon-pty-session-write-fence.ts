import { localOmpRpcSessionWriteFence } from '../omp-rpc/omp-rpc-local-session-write-fence'

export class DaemonPtySessionWriteFence {
  private readonly fences = new Map<
    string,
    { sessionFilePath: string; owner: string; incarnationId?: string }
  >()

  reserve(id: string, sessionFilePath: string, owner: string, incarnationId?: string): void {
    this.fences.set(id, { sessionFilePath, owner, incarnationId })
  }

  incarnationIdFor(id: string): string | undefined {
    return this.fences.get(id)?.incarnationId
  }

  release(id: string, incarnationId?: string): void {
    const fence = this.fences.get(id)
    if (!fence || (fence.incarnationId && incarnationId && fence.incarnationId !== incarnationId)) {
      return
    }
    localOmpRpcSessionWriteFence.release(fence.sessionFilePath, fence.owner)
    this.fences.delete(id)
  }
}
