declare module 'pako/lib/zlib/zstream.js' {
  export default class ZStream {
    input: Uint8Array
    output: Uint8Array
    avail_in: number
    avail_out: number
    next_out: number
  }
}

declare module 'pako/lib/zlib/inflate.js' {
  import type ZStream from 'pako/lib/zlib/zstream.js'
  export function inflateInit2(stream: ZStream, windowBits: number): number
  export function inflate(stream: ZStream, flush: number): number
  export function inflateEnd(stream: ZStream): number
}

declare module 'pako/lib/zlib/constants.js' {
  export const Z_FINISH: number
  export const Z_OK: number
  export const Z_STREAM_END: number
}
