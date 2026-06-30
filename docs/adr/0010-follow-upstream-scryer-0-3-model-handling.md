# Follow upstream Scryer 0.3 model handling

Normal runtime opens only `version: "0.3"` Scryer models and refuses pre-0.3 files with a clear incompatibility result. Preservation of older Orca/Scryer data belongs in an explicit import path, not automatic runtime migration.
