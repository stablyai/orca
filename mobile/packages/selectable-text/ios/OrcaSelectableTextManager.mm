#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"

@interface OrcaSelectableTextManager : RCTViewManager
@end

@implementation OrcaSelectableTextManager

RCT_EXPORT_MODULE(OrcaSelectableText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface OrcaSelectableTextRunManager : RCTViewManager
@end

@implementation OrcaSelectableTextRunManager

RCT_EXPORT_MODULE(OrcaSelectableTextRun)

- (UIView *)view
{
  return nil;
}

@end
