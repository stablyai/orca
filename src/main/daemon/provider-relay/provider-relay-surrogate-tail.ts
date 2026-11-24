export const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** Splits off a trailing high surrogate, so text cut inside a pair can wait for its second half. */
export function splitSurrogateTail(text: string): [whole: string, tail: string] {
  return isHighSurrogate(text.charCodeAt(text.length - 1))
    ? [text.slice(0, -1), text.slice(-1)]
    : [text, '']
}
