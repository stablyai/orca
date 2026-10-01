#import <UIKit/UIKit.h>

// Paints run backgrounds (inline code) only behind their glyphs, never across a
// hanging indent or the empty end of a wrapped line.
@interface OrcaSelectableTextLayoutManager : NSLayoutManager
@end

// The one TextKit 1 configuration both measurement and the view lay text out with.
NSTextContainer *OrcaSelectableTextMakeTextContainer(NSTextStorage *textStorage, CGSize size);
