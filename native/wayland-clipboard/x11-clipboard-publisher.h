#ifndef ORCA_X11_CLIPBOARD_PUBLISHER_H
#define ORCA_X11_CLIPBOARD_PUBLISHER_H

#include <stddef.h>

int publish_x11_clipboard(const unsigned char *text, size_t length);

#endif
