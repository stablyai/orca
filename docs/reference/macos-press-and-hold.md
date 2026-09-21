# macOS press-and-hold and key repeat

macOS opens the accent picker when a key is held unless an application opts out in its preferences
domain. That prevents held keys from repeating in terminal applications such as vim. On the first
eligible launch, Orca writes:

```sh
defaults write com.stablyai.orca ApplePressAndHoldEnabled -bool false
```

The write is scoped to Orca's packaged bundle domain. Bare Electron development bundles and
non-macOS platforms are left untouched. A fresh write is conservatively treated as taking effect
on the next launch.

## Precedence and decision record

Orca checks for an explicit domain value before writing. Either `true` or `false` is treated as a
user choice and preserved. Only an unset key receives the `false` default.

The decision is stored once in
`<userData>/macos-press-and-hold-default.json`. An `applied` or
`kept-user-preference` decision prevents future launches from touching the domain again.
Probe and write failures remain retryable so a transient failure does not permanently disable the
fix.

`defaults read <domain> <key>` is used instead of
`systemPreferences.getUserDefault`: the Electron API cannot distinguish an unset key from an
explicit `false`. Only the missing-key exit status is interpreted as unset; spawn failures,
timeouts, and other exit statuses leave the preference alone.

## Restoring the accent picker

Set the preference explicitly, then restart Orca:

```sh
defaults write com.stablyai.orca ApplePressAndHoldEnabled -bool true
```

After Orca has recorded its one-time decision, deleting the key also restores the macOS default
without Orca recreating it:

```sh
defaults delete com.stablyai.orca ApplePressAndHoldEnabled
```

Development and prerelease channels may use a channel-suffixed Orca bundle identifier; use that
domain instead when applicable.

## Reverting

Deleting the startup code is not enough. AppKit reads the persisted preference, so a code revert
must also arrange to delete the key for users who ran an affected build.

## Test coverage

Unit tests cover platform guards, explicit-value preservation, retry behavior, domain ownership,
record persistence, and subprocess exit interpretation on CI. A macOS-only test additionally pins
the real `defaults(1)` behavior, but current PR CI does not execute tests on macOS.
