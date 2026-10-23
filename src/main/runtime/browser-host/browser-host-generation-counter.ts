const MAX_GENERATION = 0xffff_ffff

export class BrowserHostGenerationCounter {
  private nextHostGeneration = 1
  private nextTunnelGeneration = 1

  take(kind: 'host' | 'tunnel'): number {
    const value = kind === 'host' ? this.nextHostGeneration : this.nextTunnelGeneration
    if (value > MAX_GENERATION) {
      throw new Error(`browser_${kind}_generation_exhausted`)
    }
    if (kind === 'host') {
      this.nextHostGeneration += 1
    } else {
      this.nextTunnelGeneration += 1
    }
    return value
  }
}
