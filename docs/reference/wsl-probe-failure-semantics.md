# WSL probe failure semantics

A WSL probe answers a question about a distro: is `git` installed, what is
`$HOME`, which distros are running. Every one of those probes can fail for a
reason that has nothing to do with the answer — the distro is booting, `wsl.exe`
is slow under load, the VM was just shut down.

The recurring bug in this subsystem is reporting that failure as a negative
answer.

## The shape

```ts
try {
  await execCommandInWslOrThrow(target, `${shellQuote(command)} --version`)
  return true
} catch {
  return false // "not installed" and "could not ask" are now the same value
}
```

Nothing downstream can tell those two apart, because by this point they aren't
two things.

## Why it keeps shipping

Swallowing on its own is survivable. An uncached caller asks again a moment
later and the answer corrects itself, so the bug stays invisible in review and
in manual testing.

It becomes user-visible when the swallowed value is **cached** or used to
**gate discovery**. Then a distro that was busy for one second reports no git,
or no agent sessions, until the app is relaunched. The failure is sticky,
silent, and indistinguishable from the real thing.

Three instances so far:

| Where                                | What the user saw                                                                                                                       | Status                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Preflight CLI probes                 | Caching the result would have pinned "git not installed" until relaunch                                                                 | Bounded entry ([#17350](https://github.com/stablyai/orca/pull/17350)) |
| `glab auth status` fallback into WSL | Idle VM woken repeatedly for users who never touch GitLab                                                                               | Open ([#8941](https://github.com/stablyai/orca/issues/8941))          |
| `listRunningWslDistrosAsync`         | Fails closed to `[]` with no last-known-good, polled every 2s — a persistently broken `wsl.exe` makes every WSL session vanish app-wide | Open (PR #17072 review)                                               |

## What to do instead

Pick the cheapest option that fits the call site.

1. **Don't pin it.** If the probe is cheap and uncached, swallowing is fine —
   the next call self-heals. This is what most of `src/` legitimately does.
2. **Bound the entry.** If you cache, give it a TTL so a transient failure
   expires instead of lasting the session. Cheap, no signature change, and what
   [#17350](https://github.com/stablyai/orca/pull/17350) does.
3. **Keep last-known-good.** If the probe gates discovery, fall back to the
   previous successful answer on failure rather than to empty. `listWslDistrosAsync`
   in `src/main/wsl.ts` already does this — `listRunningWslDistrosAsync`, added
   beside it, does not.
4. **Propagate the third state.** The durable fix: return
   `present | absent | unreachable` instead of a boolean, so a caller cannot
   accidentally treat "could not ask" as "no". This reaches past WSL into shared
   exec code and hasn't been done.

Whichever you pick, document why the fallback is safe for callers to cache or use for discovery.

## Reviewing failure fallbacks

Review the caller as well as the catch: whether a fallback is cached or gates discovery is a dataflow question. Returning `false`, `[]`, or `null` after a failure can be safe for some operations, but a WSL probe must preserve the distinction between absence and a distro that could not be reached. Prefer behavioral tests that exercise probe failure, discovery, caching, and recovery together.
