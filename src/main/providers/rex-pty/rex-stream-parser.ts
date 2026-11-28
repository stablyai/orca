import { StringDecoder } from 'node:string_decoder'

export class RexStreamParser {
  private readonly prefix: Buffer
  private readonly end = Buffer.from('\x1b\\')
  private pending: Buffer = Buffer.alloc(0)
  private readonly decoder = new StringDecoder('utf8')

  constructor(
    nonce: bigint,
    private emit: (text: string) => void,
    private metadata: (data: unknown) => void
  ) {
    this.prefix = Buffer.from(`\x1b_rex1;${nonce.toString()};`)
  }

  feed(data: Buffer): void {
    this.pending = Buffer.concat([this.pending, data])
    for (;;) {
      const at = this.pending.indexOf(this.prefix)
      if (at === -1) {
        let keep = Math.min(this.pending.length, this.prefix.length - 1)
        while (keep && !this.pending.subarray(-keep).equals(this.prefix.subarray(0, keep))) {
          keep--
        }
        this.output(this.pending.subarray(0, this.pending.length - keep))
        // Keep only the incomplete prefix, not the consumed frame backing store.
        this.pending = Buffer.from(this.pending.subarray(this.pending.length - keep))
        return
      }
      this.output(this.pending.subarray(0, at))
      this.pending = this.pending.subarray(at)
      const end = this.pending.indexOf(this.end, this.prefix.length)
      if ((end === -1 ? this.pending.length : end + this.end.length) > 1024 * 1024) {
        throw new Error('Rex metadata too large')
      }
      if (end === -1) {
        if (this.pending.buffer.byteLength > Math.max(Buffer.poolSize, this.pending.length)) {
          this.pending = Buffer.from(this.pending)
        }
        return
      }
      this.metadata(JSON.parse(this.pending.subarray(this.prefix.length, end).toString()))
      this.pending = this.pending.subarray(end + this.end.length)
    }
  }

  private output(bytes: Buffer): void {
    const text = this.decoder.write(bytes)
    if (text) {
      this.emit(text)
    }
  }
}
