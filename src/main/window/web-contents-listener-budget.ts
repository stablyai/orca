// Node warns past this many listeners per event name. Headroom above normal subsystem fan-out,
// still low enough that a real leak warns. Per-request listeners belong on addFanoutListener,
// not a higher cap.
export const WEB_CONTENTS_MAX_LISTENERS_PER_EVENT = 30
