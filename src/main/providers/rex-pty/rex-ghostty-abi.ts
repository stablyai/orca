// libghostty-vt 1.0.2 wasm32 ABI, pinned to the official release artifact.
// https://ghostty.org/docs/libghostty
// All pointers are offsets into WASM memory. Reacquire memory views after every call.
export class RexGhosttyAbi {
  private readonly memory: WebAssembly.Memory
  constructor(private readonly exports: WebAssembly.Exports) {
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new Error('Invalid Ghostty memory export')
    }
    this.memory = exports.memory
  }

  call(name: string, ...args: number[]): number {
    const fn = this.exports[name]
    if (typeof fn !== 'function') {
      throw new Error('Unsupported Ghostty ABI')
    }
    return fn(...args)
  }

  check(code: number): void {
    if (code !== 0) {
      throw new Error(`Ghostty ABI operation failed (${code})`)
    }
  }

  alloc(size: number): number {
    const ptr = this.call('ghostty_wasm_alloc', size)
    if (!ptr) {
      throw new Error('Ghostty allocation failed')
    }
    return ptr
  }

  free(ptr: number, size: number): void {
    this.call('ghostty_wasm_free', ptr, size)
  }

  view(): DataView {
    return new DataView(this.memory.buffer)
  }

  bytes(ptr: number, size: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, ptr, size)
  }

  opaque(create: (slot: number) => number): number {
    const slot = this.call('ghostty_wasm_alloc_opaque')
    if (!slot) {
      throw new Error('Ghostty handle allocation failed')
    }
    try {
      this.check(create(slot))
      const handle = this.call('ghostty_wasm_take_opaque', slot)
      if (!handle) {
        throw new Error('Invalid Ghostty handle')
      }
      return handle
    } finally {
      this.call('ghostty_wasm_free_opaque', slot)
    }
  }

  terminalData(terminal: number, key: number, width: 2 | 4): number {
    const out = this.alloc(width)
    try {
      this.check(this.call('ghostty_terminal_get', terminal, key, out))
      return width === 2 ? this.view().getUint16(out, true) : this.view().getUint32(out, true)
    } finally {
      this.free(out, width)
    }
  }
}
