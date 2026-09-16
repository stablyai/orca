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

Whichever you pick, say in a comment which one and why — that sentence is what
the guard below is really asking for.

## The guard

`src/main/wsl/wsl-probe-failure-semantics.test.ts` scans the WSL and preflight
probe modules for `catch { return false | [] | null }` and holds the current set
in an allowlist that only shrinks.

Its limits are worth being explicit about, because they decide how much it is
worth trusting:

- **It cannot see the dangerous part.** Whether a swallowed value is later
  cached or gates discovery is dataflow, not syntax. Every allowlisted entry is
  currently safe; the guard does not verify that and cannot.
- **It is scoped, not global.** The same shape appears ~850 times across `src/`
  and is usually correct, because for most callers a failure genuinely does mean
  absent. Enforcing it repo-wide would be noise. It only matters where the
  answer describes a WSL distro.
- **It catches a shape, not a mistake.** Code can conflate failure and absence
  without ever writing `catch { return false }`.

So it does not prevent the bug. What it does is stop a new swallow site
appearing in these modules without someone stating why the value is safe to
pin — which is the review conversation that was missing all three times.
