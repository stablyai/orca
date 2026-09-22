/**
 * The page saying its first frame is up, and the declaration that says it will.
 *
 * A WebView that has mounted and not yet painted draws nothing, so what is on screen is whatever
 * is behind it — for a cached generation, the shell's own surface and nothing on it, for as long
 * as the page takes to boot. Only the page knows when it has a frame, so the page says so and the
 * shell uncovers on the word rather than on a timer.
 *
 * `ready.reports` is what bounds the wait. The generation is served by a desktop that updates
 * independently of the installed shell, so a shell that waited for this notify unasked would hide
 * a working page built before the notify existed, for the life of the document. A page that does
 * not declare it is uncovered when it says `ready`, which is the shell's own oldest evidence that
 * the page's code ran at all.
 *
 * One name in both roles on purpose: the notify the page posts and the entry it lists are the same
 * capability, and two spellings would be two things to keep in step.
 */
export const BRIDGE_PAGE_PAINTED = 'painted'
