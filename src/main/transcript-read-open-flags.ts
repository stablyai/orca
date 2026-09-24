import { constants } from 'node:fs'

/**
 * Open flags every transcript reader uses.
 *
 * `O_NOFOLLOW` refuses a symlink planted on the final path component between
 * the resolver's check and the reader's open, so a swapped path fails instead
 * of vouching for bytes outside the transcript tree. `O_NONBLOCK` keeps a FIFO
 * left in a session directory from parking the reader forever — a blocking open
 * of a writer-less FIFO never returns.
 *
 * Both constants are POSIX-only; on Windows they are absent and degrade to 0,
 * leaving the plain read-only open the platform already performs.
 *
 * `createReadStream`'s `flags` option is a string mode and cannot carry these,
 * so stream readers open a handle with them and stream off it instead.
 */
export const TRANSCRIPT_READ_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
