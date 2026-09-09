# Office render fixtures

Built with `officecli 1.0.148` on macOS. Small on purpose — the point is coverage of the
properties the preview depends on, not realistic documents.

| File          | Covers                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------- |
| `sample.docx` | a paragraph, a 2×2 table, and an embedded PNG                                               |
| `sample.xlsx` | a small sheet, so the spreadsheet renderer is exercised at all                              |
| `sample.pptx` | one slide with a text shape and an embedded PNG                                             |
| `sample.docm` | a genuine macro-enabled package: macro content type, `vbaProject.bin` part and relationship |

`sample.docm` exists to hold the Phase 0 verdict in place. The plan listed macro-enabled formats
as "probably not renderable"; against 1.0.148 they render, and the tool's own unsupported-type
message names them as supported. If a future version stops rendering them, the render test fails
here rather than in front of a reader.

The `.png` is generated, not sourced: 64×64, a few hundred bytes, no license to track.
