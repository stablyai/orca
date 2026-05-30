# Developing

## Release Channels

The public Homebrew cask tracks stable desktop releases:

```bash
brew install --cask stablyai/orca/orca
```

Release candidates use a separate cask token:

```bash
brew install --cask stablyai/orca/orca@rc
```

The two casks conflict because both install `Orca.app`. Switch channels with a
normal `brew uninstall --cask` followed by the install for the other channel.
Do not use `--zap` unless you intentionally want to remove local Orca state.
