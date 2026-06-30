# Native Scryer engine owns state semantics

The Native Scryer Engine is the only module that owns Scryer state semantics such as planned/committed layers, locking, history, anchors, drift, and health. CLI, IPC, UI, sync, and import paths call the engine instead of implementing their own model rules.
