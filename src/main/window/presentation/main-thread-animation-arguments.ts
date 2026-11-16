// A compositor animation ticking through a multi-second main-thread task wedges Chromium's frame sorter,
// pinning a compositor core until the window hides (#14882); main-thread animations pause with the task.
export const MAIN_THREAD_ANIMATION_ARGUMENTS: readonly string[] = ['--disable-threaded-animation']
